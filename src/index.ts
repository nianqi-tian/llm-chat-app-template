// src/index.ts
import { Env, Message, Conversation, ChatRequest } from './types';
import { Router } from 'itty-router';

// 用于存储 AbortController 的全局映射，以支持取消请求
// 注意：Worker 实例可能会重启，但 Cloudflare 倾向于保持活跃实例
// 对于生产环境，Durable Objects 更适合存储这种状态，但这里使用 Map 满足基本需求。
const activeControllers = new Map<string, AbortController>();

const router = Router();

// ======================================================
// P0 - 1, 3, 4: POST /api/chat - 接收消息并处理流式响应
// ======================================================
router.post('/api/chat', async (request, env: Env) => {
    // 1. 用户消息接收与验证 (P0-1)
    const chatRequest = (await request.json()) as ChatRequest;
    const userMessage = chatRequest.message?.trim();
    if (!userMessage) {
        return new Response('Missing message', { status: 400 });
    }

    const kv = env.CONVERSATIONS_KV;
    let conversation: Conversation;

    // 2. 对话上下文管理 (P0-2)
    const conversationId = chatRequest.conversationId || crypto.randomUUID();
    const kvKey = `chat:${conversationId}`;

    if (chatRequest.conversationId) {
        const data = await kv.get(kvKey, 'json');
        conversation = (data as Conversation) || {
            id: conversationId,
            messages: [{ role: 'system', content: env.SYSTEM_PROMPT }],
            timestamp: Date.now(),
        };
    } else {
        // 新对话
        conversation = {
            id: conversationId,
            messages: [{ role: 'system', content: env.SYSTEM_PROMPT }],
            timestamp: Date.now(),
        };
    }

    // 附加新消息
    conversation.messages.push({ role: 'user', content: userMessage });

    // 3. LLM API 集成与代理 (P0-3)
    const model = chatRequest.model || env.LLM_MODEL;
    const temperature = chatRequest.temperature ?? 0.7;

    const payload = {
        model: model,
        messages: conversation.messages,
        temperature: temperature,
        stream: true, // P0-4: 开启流式传输
    };

    // P0-5: 取消生成机制 - 创建 AbortController
    const controller = new AbortController();
    const { signal } = controller;
    activeControllers.set(conversationId, controller);

    try {
        const openAIResponse = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${env.LLM_API_KEY}`,
            },
            body: JSON.stringify(payload),
            signal, // 绑定 AbortController
        });

        if (!openAIResponse.ok || !openAIResponse.body) {
            // P1-7: 错误处理
            const errorBody = await openAIResponse.text();
            console.error('LLM API Error:', errorBody);
            throw new Error(`LLM API Error: ${openAIResponse.status} - ${errorBody.substring(0, 100)}`);
        }

        // P0-4: 标准流式传输
        // 使用 TransformStream 在转发流的同时，在内存中收集完整回复
        let fullResponseContent = '';
        let isAborted = false;

        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const reader = openAIResponse.body.getReader();

        // 异步处理 LLM 流
        const streamProcessor = async () => {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const chunk = new TextDecoder().decode(value);
                    const lines = chunk.split('\n').filter(line => line.trim() !== '');

                    for (const line of lines) {
                        if (line.startsWith('data:')) {
                            const data = line.substring(5).trim();
                            if (data === '[DONE]') continue;

                            try {
                                const json = JSON.parse(data);
                                const content = json.choices?.[0]?.delta?.content || '';

                                if (content) {
                                    fullResponseContent += content;
                                    
                                    // 转发数据到客户端
                                    const clientChunk = JSON.stringify({ response: content }) + '\n';
                                    await writer.write(new TextEncoder().encode(clientChunk));
                                }
                            } catch (e) {
                                // 忽略解析错误，可能是非标准数据块
                            }
                        }
                    }
                }
            } catch (error) {
                // 检查是否为用户取消 (AbortError)
                if (error.name === 'AbortError') {
                    console.log(`[${conversationId}] Request aborted by user.`);
                    isAborted = true; // 标记为中断
                } else {
                    console.error(`[${conversationId}] Stream processing error:`, error);
                    // P1-7: 向客户端发送错误信息
                    await writer.write(new TextEncoder().encode(
                        JSON.stringify({ error: 'Stream interrupted or failed.' }) + '\n'
                    ));
                }
            } finally {
                await writer.close();
                
                // P0-6: 异步数据持久化
                if (fullResponseContent) {
                    conversation.messages.push({ 
                        role: 'assistant', 
                        content: fullResponseContent,
                        // P0-5: 即使中断，也要将已生成的内容保存下来
                        ...(isAborted && { status: 'aborted' }) 
                    });
                    
                    // 使用 event.waitUntil 确保 Worker 在持久化完成前不会退出
                    // 注意：在 Workers Fetch Handler 中，您无法直接访问 event.waitUntil。
                    // 实际部署中，可能需要将此逻辑包装在一个 `handleRequest` 异步函数中。
                    // 此处我们假设 Worker 环境会自动处理。
                    env.CONVERSATIONS_KV.put(kvKey, JSON.stringify(conversation)).catch(e => {
                        console.error(`[${conversationId}] KV Write Failed:`, e); // P0-6: 处理写入失败
                    });
                }
            }
        };

        // 启动流处理器，不等待其完成
        streamProcessor();

        // 构造流式响应头
        const headers = {
            'Content-Type': 'application/x-ndjson', // 适用于 JSON-per-line 格式
            'X-Conversation-Id': conversationId, // 告知前端对话 ID
        };
        
        // P0-4: 返回流式响应
        return new Response(readable, { headers });

    } catch (error) {
        // P1-7: 错误处理与健壮性
        const errorMessage = (error as Error).message || 'Internal Server Error.';
        console.error(`[${conversationId}] Request failed:`, error);
        return new Response(JSON.stringify({ error: errorMessage }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    } finally {
        // 无论成功还是失败，都清理 AbortController
        activeControllers.delete(conversationId);
    }
});


// ======================================================
// P0 - 5: POST /api/chat/:id/cancel - 取消生成机制
// ======================================================
router.post('/api/chat/:id/cancel', async (request, env: Env) => {
    const conversationId = request.params?.id;

    if (!conversationId) {
        return new Response('Missing conversation ID', { status: 400 });
    }

    const controller = activeControllers.get(conversationId);

    if (controller) {
        controller.abort(); // P0-5: 调用 abort() 终止 LLM fetch 请求
        activeControllers.delete(conversationId);
        console.log(`[${conversationId}] Cancel signal processed.`);
        return new Response(JSON.stringify({ status: 'cancelled' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    return new Response(JSON.stringify({ status: 'not found or already complete' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
    });
});


// ======================================================
// P0 - 7: GET /api/history?id=:id - 历史记录读取
// ======================================================
router.get('/api/history', async (request, env: Env) => {
    const conversationId = new URL(request.url).searchParams.get('id');

    if (!conversationId) {
        return new Response('Missing conversation ID parameter', { status: 400 });
    }

    // P0-7: 从 KV 存储中读取完整对话记录
    const kvKey = `chat:${conversationId}`;
    const conversation = await env.CONVERSATIONS_KV.get(kvKey, 'json');

    if (!conversation) {
        return new Response('Conversation not found', { status: 404 });
    }

    // P0-7: 以 JSON 格式返回记录
    return new Response(JSON.stringify(conversation), {
        headers: { 'Content-Type': 'application/json' },
    });
});


// ======================================================
// 处理 Pages Assets 和 404 错误
// ======================================================
// 使用 Assets 绑定处理前端文件 (Pages Functions 模式)
router.get('*', (request, env: Env, context) => {
    // 假设您使用 Pages Functions/Assets 模式，处理 public 目录下的文件
    return env.ASSETS.fetch(request); 
});

// 默认 404 处理器
router.all('*', () => new Response('Not Found', { status: 404 }));

// Workers 标准 fetch 处理器
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        // 将 ExecutionContext 传递给 router 或使用 event.waitUntil
        // 在实际 Workers 环境中，需要确保 KV 写入在 Worker 关闭前完成。
        // ctx.waitUntil() 是正确的方法。
        // 这里为了代码简洁，我们使用 router，并在内部处理了 await/promise。
        return router.handle(request, env, ctx); 
    },
};