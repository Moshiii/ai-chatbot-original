export const DEFAULT_CHAT_MODEL: string = 'chat-model';

export interface ChatModel {
  id: string;
  name: string;
  description: string;
}

export const chatModels: Array<ChatModel> = [
  {
    id: 'chat-model',
    name: 'OpenAI GPT-4 Vision',
    description: 'OpenAI GPT-4 model with multimodal vision and text capabilities',
  },
  {
    id: 'chat-model-reasoning',
    name: 'OpenAI GPT-4 Reasoning',
    description: 'GPT-4 model optimized for advanced chain-of-thought reasoning on complex problems',
  },
  {
    id: 'a2a-model',
    name: 'A2A Chat',
    description: 'Chat powered by on-prem A2A AI server',
  },
];
