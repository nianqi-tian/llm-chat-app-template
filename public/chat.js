/**
 * LLM Chat App Frontend
 *
 * 核心功能：处理聊天的用户界面交互，管理对话状态，并与 Cloudflare Worker 后端 API 进行通信。
 */

// --- 1. DOM 元素选择器 ---
const chatMessages = document.getElementById("chat-messages"); // 聊天消息容器
const userInput = document.getElementById("user-input");       // 用户输入框 (textarea)
const sendButton = document.getElementById("send-button");     // 发送按钮
const typingIndicator = document.getElementById("typing-indicator"); // "AI 正在输入..." 提示

// --- 2. 聊天状态管理 ---
let chatHistory = [
    {
        role: "assistant",
        content:
            "Hello! I'm an LLM chat app powered by Cloudflare Workers AI. How can I help you today?",
    },
]; // 存储完整的对话历史，用于发送给后端以维护上下文
let isProcessing = false; // 状态锁，防止用户在 AI 响应时发送新消息

// --- 3. UI 交互事件监听 ---

// 自动调整输入框大小：根据内容高度自动增长或收缩
userInput.addEventListener("input", function () {
    this.style.height = "auto";
    this.style.height = this.scrollHeight + "px"; // 将高度设置为内容实际高度
});

// 键盘事件：按 Enter 发送消息（如果未按住 Shift）
userInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault(); // 阻止默认的换行行为
        sendMessage();
    }
});

// 鼠标事件：点击发送按钮发送消息
sendButton.addEventListener("click", sendMessage);

/**
 * 核心函数：发送消息到后端 API 并处理流式响应
 */
async function sendMessage() {
    const message = userInput.value.trim();

    // 检查：如果消息为空或正在处理中，则退出
    if (message === "" || isProcessing) return;

    // --- 4. 状态更新 (发送前) ---
    isProcessing = true;
    userInput.disabled = true;
    sendButton.disabled = true;

    // 1. 将用户消息渲染到 UI
    addMessageToChat("user", message);

    // 2. 清理输入框并重置大小
    userInput.value = "";
    userInput.style.height = "auto";

    // 3. 显示正在输入指示器
    typingIndicator.classList.add("visible");

    // 4. 将用户消息添加到历史记录 (用于上下文)
    chatHistory.push({ role: "user", content: message });

    try {
        // --- 5. 准备接收流式响应的 UI 元素 ---
        const assistantMessageEl = document.createElement("div");
        assistantMessageEl.className = "message assistant-message";
        assistantMessageEl.innerHTML = "<p></p>";
        chatMessages.appendChild(assistantMessageEl);

        // 滚动到底部，显示最新的 UI 元素
        chatMessages.scrollTop = chatMessages.scrollHeight;

        // --- 6. 发送 API 请求 (POST /api/chat) ---
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                // 将完整的对话历史发送给后端，以便 LLM 维持上下文
                messages: chatHistory,
            }),
        });
        
        // 

        // 错误处理：检查 HTTP 状态码
        if (!response.ok) {
            throw new Error(`API Request Failed: ${response.statusText}`);
        }

        // --- 7. 核心流式响应处理 ---
        // 获取响应体阅读器，用于逐块读取数据
        const reader = response.body.getReader();
        // 文本解码器，用于将 Uint8Array (二进制数据) 转换为字符串
        const decoder = new TextDecoder();
        let responseText = ""; // 收集 AI 的完整回复内容

        while (true) {
            // 读取下一块数据 (chunk)
            const { done, value } = await reader.read();

            if (done) {
                // 读取完成，退出循环
                break;
            }

            // 解码当前数据块
            const chunk = decoder.decode(value, { stream: true });

            // **处理 SSE (Server-Sent Events) 或类似格式**
            // 假设后端 Worker 以每行一个 JSON 对象的形式发送数据
            const lines = chunk.split("\n");
            for (const line of lines) {
                if (!line.trim()) continue; // 跳过空行

                try {
                    // 解析后端 Worker 发送的 JSON 数据
                    const jsonData = JSON.parse(line);
                    
                    if (jsonData.response) {
                        // 1. 累计 AI 生成的内容
                        responseText += jsonData.response;
                        // 2. 实时更新 UI 元素的内容
                        assistantMessageEl.querySelector("p").textContent = responseText;

                        // 3. 保持滚动到最新消息
                        chatMessages.scrollTop = chatMessages.scrollHeight;
                    }
                } catch (e) {
                    // 忽略 JSON 解析错误，因为一个数据块可能包含不完整的 JSON
                    console.error("Error parsing JSON, likely an incomplete chunk:", e);
                }
            }
        }

        // --- 8. 流式响应结束后 ---
        // 将 AI 的完整回复添加到历史记录，用于下一轮对话的上下文
        chatHistory.push({ role: "assistant", content: responseText });
    } catch (error) {
        // 捕获 API 调用或网络错误
        console.error("Error:", error);
        // 向用户显示错误提示
        addMessageToChat(
            "assistant",
            "Sorry, there was an error processing your request. Please check the console for details.",
        );
    } finally {
        // --- 9. 状态重置 (无论成功或失败都会执行) ---
        // 隐藏正在输入指示器
        typingIndicator.classList.remove("visible");

        // 重新启用输入
        isProcessing = false;
        userInput.disabled = false;
        sendButton.disabled = false;
        userInput.focus();
    }
}

/**
 * 辅助函数：将消息添加到聊天 UI 容器中
 * @param {string} role - 消息发送者角色 ('user' 或 'assistant')
 * @param {string} content - 消息内容 (纯文本)
 */
function addMessageToChat(role, content) {
    const messageEl = document.createElement("div");
    messageEl.className = `message ${role}-message`; // 应用 CSS 样式
    messageEl.innerHTML = `<p>${content}</p>`;
    chatMessages.appendChild(messageEl);

    // 确保滚动到最底部
    chatMessages.scrollTop = chatMessages.scrollHeight;
}