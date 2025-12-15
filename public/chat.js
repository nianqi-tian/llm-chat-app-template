/**
 * LLM Chat App Frontend
 */

// DOM elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const cancelButton = document.getElementById("cancel-button"); // <-- 新增: 取消按钮

// Chat state
let conversationId = null; // <-- 核心修改: 存储对话 ID
let isProcessing = false;
let chatHistory = [
    {
        role: "assistant",
        content:
            "Hello! I'm an LLM chat app powered by Cloudflare. How can I help you today?",
    },
];

// ... (原有事件监听器: input, keydown, sendButton click) ...
cancelButton.addEventListener("click", cancelGeneration); // <-- 新增: 取消事件监听

/**
 * P0-5: 取消生成机制：调用后端取消端点
 */
async function cancelGeneration() {
    if (!conversationId || !isProcessing) {
        return;
    }

    try {
        console.log(`Sending cancel request for ID: ${conversationId}`);
        cancelButton.disabled = true; // 禁用按钮，防止多次点击

        const response = await fetch(`/api/chat/${conversationId}/cancel`, {
            method: "POST",
        });

        if (response.ok) {
            console.log("Generation successfully cancelled.");
            // 后端应该已经终止了流，我们等待 sendMessage 中的 while 循环自然退出
        } else {
            console.error("Failed to send cancellation request or already complete.");
        }
    } catch (error) {
        console.error("Error during cancellation:", error);
    }
}


/**
 * Sends a message to the chat API and processes the response
 */
async function sendMessage() {
    const message = userInput.value.trim();

    if (message === "" || isProcessing) return;

    // ... (省略输入禁用、清空和显示指示器逻辑) ...

    addMessageToChat("user", message);
    chatHistory.push({ role: "user", content: message });

    // 核心修改: 构造携带 conversationId 的 payload
    const payload = {
        message: message,
        conversationId: conversationId, // 如果是新对话，则为 null
    };

    try {
        // ... (省略创建 assistantMessageEl 和滚动逻辑) ...

        // 显示取消按钮
        cancelButton.classList.add("visible");
        cancelButton.disabled = false; // 启用取消按钮

        // Send request to API
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });

        // 检查后端是否返回了新的 conversationId
        const newConversationId = response.headers.get("X-Conversation-Id");
        if (newConversationId) {
            conversationId = newConversationId; // 更新 ID
            console.log(`Updated conversationId: ${conversationId}`);
        }

        // Handle errors
        if (!response.ok || !response.body) {
            // P1-7: 友好的错误信息
            const errorData = await response.json();
            throw new Error(errorData.error || "Failed to get streaming response from proxy.");
        }

        // Process streaming response
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let responseText = "";
        let isAborted = false;

        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                // 如果是取消请求，流会快速结束
                if (cancelButton.disabled && isProcessing) {
                     isAborted = true; // 假设流提前结束即为中断
                }
                break;
            }
            
            // ... (省略原有 SSE 处理逻辑: JSON.parse(line), append content) ...
            
            // 示例：处理流式数据块
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split("\n");
            for (const line of lines) {
                try {
                    const jsonData = JSON.parse(line);
                    if (jsonData.response) {
                        responseText += jsonData.response;
                        assistantMessageEl.querySelector("p").textContent = responseText;
                        chatMessages.scrollTop = chatMessages.scrollHeight;
                    } 
                    // P1-7: 处理后端在流中发送的错误信息
                    else if (jsonData.error) {
                        throw new Error(jsonData.error);
                    }
                } catch (e) {
                    // 忽略解析错误
                }
            }
        }

        // Add completed response to chat history
        if (responseText) {
             const statusTag = isAborted ? " [已中断]" : "";
             chatHistory.push({ role: "assistant", content: responseText + statusTag });
             // P0-5: 如果中断，标记前端消息
             if (isAborted) {
                 assistantMessageEl.querySelector("p").textContent += statusTag;
                 assistantMessageEl.classList.add("aborted-message");
             }
        }

    } catch (error) {
        console.error("Error:", error);
        addMessageToChat(
            "assistant",
            `🚨 错误: ${error.message || "请求处理失败。"}`,
        );
    } finally {
        // 隐藏指示器和取消按钮，并重新启用输入
        typingIndicator.classList.remove("visible");
        cancelButton.classList.remove("visible");
        cancelButton.disabled = false; // 重置
        
        isProcessing = false;
        userInput.disabled = false;
        sendButton.disabled = false;
        userInput.focus();
    }
}

// ... (原有 addMessageToChat 辅助函数) ...