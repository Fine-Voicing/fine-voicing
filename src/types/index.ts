import WebSocket from 'ws';

export interface AudioChunk {
  data: Buffer;
  streamSid: string;
  modelInstanceId?: string;
}

export interface TextChunk {
  text: string;
  streamSid: string;
  modelInstanceId?: string;
}

export interface ErrorEvent {
  error: Error;
  streamSid: string;
  modelInstanceId?: string;
}

export interface ConversationItem {
  role: 'user' | 'assistant' | 'moderator';
  role_name?: string;
  content: string;
}

export interface PersonaInstruction {
  role_name: string;
  role_prompt: string;
}

export interface PersonaInstructions {
  testing_role: PersonaInstruction;
  moderator: PersonaInstruction;
}

export interface LLMService {
  stream(prompt: string, onData: (chunk: string) => void): Promise<void>;
  complete(prompt: string): Promise<string>;
}

export interface TTSService {
  streamTTS(text: string, onData: (chunk: Buffer) => void, modelInstanceId?: string): Promise<void>;
}

export interface STTService {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendAudio(audioChunk: AudioChunk): Promise<void>;
} 

export enum AGENT_MODE {
  LLM = 'llm',
  STS = 'sts',
}

export enum AGENT_POSTURE { 
  BASELINE = 'baseline',
  EDGE = 'edge',
  ATTACKER = 'attacker',
}

export type OutboundCallMessage = {
  msg_id: string;
  read_ct: number;
  message: {
    user_id: string;
    conversation_id: string;
    model_instance_id: string;
    to_phone_number: string;
    is_demo: boolean;
  }
}

export type ModelInstanceConfig = {
  language?: string;
  max_turns?: number;
  posture?: AGENT_POSTURE;
  custom_posture?: string;
}

export type ModelInstance = {
  instance_id?: string;
  provider: string;
  model: string;
  voice: string;
  config: ModelInstanceConfig;
}

export type EmailContext = {
  prompt: string;
  transcript: ConversationItem[];
  duration: number;
  to_phone_number: string;
  secureLink: string;
}