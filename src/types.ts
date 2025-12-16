// src/types.ts

// Worker 环境变量接口，用于类型安全地访问绑定
export interface Env {
    ASSETS: { fetch: typeof fetch }; // Workers AI 模板通常包含这个用于服务前端静态文件
    AI: { run: (model: string, inputs: any, options?: any) => Promise<any> }; // Workers AI 绑定
    CHAT_HISTORY: KVNamespace;       // 我们为 KV 历史记录添加的绑定

    // --- 配置化的 LLM 参数（在 wrangler.jsonc vars 中设置） ---
    MODEL_ID?: string;
    TEMPERATURE?: string | number;
    MAX_OUTPUT_TOKENS?: string | number;
    MAX_CONTEXT_TOKENS?: string | number;

    // Rate limit 配置
    RATE_LIMIT_WINDOW_SEC?: string | number;
    RATE_LIMIT_MAX_REQUESTS?: string | number;

    // ⚠️ 如果您使用 OpenAI 兼容 API 而不是 Workers AI，请添加以下内容
    // OPENAI_API_KEY: string;
    // LLM_ENDPOINT: string; 
}


// 核心消息结构 (我们用于 KV 存储和内部上下文管理)
export interface Message {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    interrupted?: boolean; // 标记是否被取消
}

// Workers AI SDK 定义的消息结构
export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

// 对话历史记录是 Message 数组
export type ConversationHistory = Message[];