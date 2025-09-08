import {
  customProvider,
  extractReasoningMiddleware,
  wrapLanguageModel,
} from 'ai';
import { openai } from '@ai-sdk/openai';
import {
  artifactModel,
  chatModel,
  reasoningModel,
  titleModel,
} from './models.test';
import { isTestEnvironment } from '../constants';
import { a2a } from 'a2a-ai-provider';

export const myProvider = isTestEnvironment
  ? customProvider({
      languageModels: {
        'chat-model': chatModel,
        'chat-model-reasoning': reasoningModel,
        'title-model': titleModel,
        'artifact-model': artifactModel,
      },
    })
  : customProvider({
      languageModels: {
        'chat-model': openai.languageModel('gpt-4'),
        'chat-model-reasoning': wrapLanguageModel({
          model: openai.languageModel('gpt-4'),
          middleware: extractReasoningMiddleware({ tagName: 'think' }),
        }),
        'title-model': openai.languageModel('gpt-4'),
        'artifact-model': openai.languageModel('gpt-4'),
        'a2a-model': a2a('http://localhost:9999'),
      },
    });
