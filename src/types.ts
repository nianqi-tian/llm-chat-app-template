// src/types.ts

// Worker 环境变量接口
export interface Env {
    // KV 绑定，来自 wrangler.jsonc
    CONVERSATIONS_KV: KVNamespace; 
    // Secret 绑定，来自 wrangler secret put
    LLM_API_KEY: string; 
    // Vars 绑定，来自 wrangler.jsonc
    LLM_MODEL: string;
    SYSTEM_PROMPT: string;
    // Cloudflare Workers AI 绑定 (如果使用 @cloudflare/ai)
    AI: any; 
}

// LLM 消息格式
export interface Message {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

// 存储在 KV 中的对话结构
export interface Conversation {
    id: string;
    messages: Message[];
    timestamp: number;
    // 可选：用于存储 LLM API 调用的模型配置
    settings?: {
        model: string;
        temperature: number;
    }
}

// 前端发送的请求体
export interface ChatRequest {
    message: string;
    conversationId: string | null;
    // 允许前端覆盖模型配置
    model?: string;
    temperature?: number;
}