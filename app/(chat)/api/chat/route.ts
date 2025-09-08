import {
  convertToModelMessages,
  createUIMessageStream,
  JsonToSseTransformStream,
  smoothStream,
  stepCountIs,
  streamText,
} from 'ai';
import { auth, type UserType } from '@/app/(auth)/auth';
import { type RequestHints, systemPrompt } from '@/lib/ai/prompts';
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
} from '@/lib/db/queries';
import { convertToUIMessages, generateUUID } from '@/lib/utils';
import { generateTitleFromUserMessage } from '../../actions';
import { createDocument } from '@/lib/ai/tools/create-document';
import { updateDocument } from '@/lib/ai/tools/update-document';
import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
import { getWeather } from '@/lib/ai/tools/get-weather';
import { isProductionEnvironment } from '@/lib/constants';
import { myProvider } from '@/lib/ai/providers';
import { entitlementsByUserType } from '@/lib/ai/entitlements';
import { postRequestBodySchema, type PostRequestBody } from './schema';
import { geolocation } from '@vercel/functions';
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from 'resumable-stream';
import { after } from 'next/server';
import { ChatSDKError } from '@/lib/errors';
import type { ChatMessage } from '@/lib/types';
import type { ChatModel } from '@/lib/ai/models';
import type { VisibilityType } from '@/components/visibility-selector';

export const maxDuration = 60;

let globalStreamContext: ResumableStreamContext | null = null;

export function getStreamContext() {
  if (!globalStreamContext) {
    try {
      globalStreamContext = createResumableStreamContext({
        waitUntil: after,
      });
    } catch (error: any) {
      if (error.message.includes('REDIS_URL')) {
        console.log(
          ' > Resumable streams are disabled due to missing REDIS_URL',
        );
      } else {
        console.error(error);
      }
    }
  }

  return globalStreamContext;
}

export function normaliseA2AParts(parts: any[]) {
  // A2A emits [{type:'step-start'}, {type:'text', text:'foo'}, {type:'step-end'}]
  // or sometimes just one large {type:'text', text:'...'} chunk at the end.
  // Filter non-text parts and merge text segments.
  const text = parts
    .filter((p: any) => p.type === 'text')
    .map((p: any) => p.text)
    .join('');
  return text
    ? [{ type: 'text', text }]
    : [];            // fallback – UI will render nothing
}

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    console.log('Received chat request:', json);
    requestBody = postRequestBodySchema.parse(json);
  } catch (error) {
    console.error('Failed to parse request body:', error);
    return new ChatSDKError('bad_request:api').toResponse();
  }

  try {
    const {
      id,
      message,
      selectedChatModel,
      selectedVisibilityType,
    }: {
      id: string;
      message: ChatMessage;
      selectedChatModel: ChatModel['id'];
      selectedVisibilityType: VisibilityType;
    } = requestBody;

    console.log('Processing chat request with ID:', id);
    const session = await auth();

    if (!session?.user) {
      console.log('No authenticated user found');
      return new ChatSDKError('unauthorized:chat').toResponse();
    }

    console.log('Authenticated user:', session.user);
    const userType: UserType = session.user.type;

    const messageCount = await getMessageCountByUserId({
      id: session.user.id,
      differenceInHours: 24,
    });
    console.log('User message count:', messageCount);

    if (messageCount > entitlementsByUserType[userType].maxMessagesPerDay) {
      console.log('User exceeded message limit');
      return new ChatSDKError('rate_limit:chat').toResponse();
    }

    const chat = await getChatById({ id });
    console.log('Existing chat:', chat);

    if (!chat) {
      console.log('Creating new chat...');
      const title = await generateTitleFromUserMessage({
        message,
      });
      console.log('Generated title:', title);

      await saveChat({
        id,
        userId: session.user.id,
        title,
        visibility: selectedVisibilityType,
      });
      console.log('New chat saved successfully');
    } else {
      if (chat.userId !== session.user.id) {
        console.log('User not authorized to access chat');
        return new ChatSDKError('forbidden:chat').toResponse();
      }
    }

    console.log('Fetching messages from DB for chat ID:', id);
    const messagesFromDb = await getMessagesByChatId({ id });
    console.log('Messages from DB:', JSON.stringify(messagesFromDb, null, 2));

    const uiMessages = [...convertToUIMessages(messagesFromDb), message];
    console.log('UI messages prior to streaming:', JSON.stringify(uiMessages, null, 2));

    console.log('Getting geolocation from request...');
    const { longitude, latitude, city, country } = geolocation(request);
    console.log('Geolocation data:', { longitude, latitude, city, country });

    const requestHints: RequestHints = {
      longitude,
      latitude,
      city,
      country,
    };

    if (selectedChatModel === 'a2a-model') {
      console.log('Raw A2A parts:', JSON.stringify(message.parts, null, 2));
    }

    const cleaned = selectedChatModel === 'a2a-model'
      ? normaliseA2AParts(message.parts)
      : message.parts;

    await saveMessages({
      messages: [
        {
          chatId: id,
          id: message.id,
          role: 'user',
          parts: cleaned,
          attachments: [],
          createdAt: new Date(),
        },
      ],
    });

    const streamId = generateUUID();
    await createStreamId({ streamId, chatId: id });

    const stream = createUIMessageStream({
      execute: ({ writer: dataStream }) => {
        const result = streamText({
          model: myProvider.languageModel(selectedChatModel),
          system: systemPrompt({ selectedChatModel, requestHints }),
          messages: convertToModelMessages(uiMessages),
          stopWhen: stepCountIs(5),
          experimental_activeTools:
            selectedChatModel === 'chat-model'
              ? [
                  'getWeather',
                  'createDocument',
                  'updateDocument',
                  'requestSuggestions',
                ]
              : [],
          experimental_transform: smoothStream({ chunking: 'word' }),
          tools: selectedChatModel === 'chat-model'
            ? {
                getWeather,
                createDocument: createDocument({ session, dataStream }),
                updateDocument: updateDocument({ session, dataStream }),
                requestSuggestions: requestSuggestions({
                  session,
                  dataStream,
                }),
              }
            : undefined,
          experimental_telemetry: {
            isEnabled: isProductionEnvironment,
            functionId: 'stream-text',
          },
        });

        result.consumeStream();

        dataStream.merge(
          result.toUIMessageStream({
            sendReasoning: true,
          }),
        );
      },
      generateId: generateUUID,
      onFinish: async ({ messages }) => {
        console.log('Stream finished. Messages to save:', messages);
        messages.forEach((message, idx) => {
          console.log(`Message ${idx}:`, message);
        });
        await saveMessages({
          messages: messages.map((message) => {
            const parts =
              selectedChatModel === 'a2a-model'
                ? normaliseA2AParts(message.parts)
                : message.parts;
            return {
              id: message.id,
              role: message.role,
              parts,
              createdAt: new Date(),
              attachments: [],
              chatId: id,
            };
          }),
        });
        console.log('Messages saved to DB');
      },
      onError: (streamError) => {
        console.error('Error within createUIMessageStream:', streamError);
        if (streamError instanceof Error) {
          console.error('Error stack:', streamError.stack);
        }
        return 'Oops, an error occurred!';
      },
    });

    const streamContext = getStreamContext();

    if (streamContext) {
      return new Response(
        await streamContext.resumableStream(streamId, () =>
          stream.pipeThrough(new JsonToSseTransformStream()),
        ),
      );
    } else {
      return new Response(stream.pipeThrough(new JsonToSseTransformStream()));
    }
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }

    console.error('Unhandled error in chat API:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
      // Some libraries (like Axios) attach response data to error.response
      // Attempt to log that too if present
      // @ts-ignore
      if (error.response) {
        // @ts-ignore
        console.error('Error response status:', error.response.status);
        // @ts-ignore
        console.error('Error response data:', error.response.data);
      }
      // Log any aggregated errors
      // AggregateError errors store individual errors in .errors
      // @ts-ignore
      if (error.errors && Array.isArray(error.errors)) {
        // @ts-ignore
        console.error('Aggregate sub-errors:', error.errors);
      }
    }
    return new ChatSDKError('offline:chat').toResponse();
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError('unauthorized:chat').toResponse();
  }

  const chat = await getChatById({ id });

  if (chat.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
