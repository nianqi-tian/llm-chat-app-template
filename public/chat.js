/**
 * LLM Chat App Frontend (v2.0 - 增强版)
 *
 * 核心功能：处理聊天的用户界面交互，管理对话状态，并与 Cloudflare Worker 后端 API 进行通信。
 * 增强功能：
 * 1. 使用 conversationId 实现对话上下文持久化 (P0)。
 * 2. 增加 AbortController 实现生成取消机制 (P0)。
 */

// --- 1. DOM 元素选择器 ---
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
// 🚨 新增：取消按钮 (您需要在 HTML 中添加 id="cancel-button" 的元素)
const cancelButton = document.getElementById("cancel-button");

// --- 2. 聊天状态管理 ---
let chatHistory = [
    {
        role: "assistant",
        content:
            "Hello! I'm an LLM chat app powered by Cloudflare Workers AI. How can I help you today?",
    },
]; // 仅用于 UI 渲染的本地历史记录，后端使用 KV 存储完整的上下文。
let isProcessing = false;
// 🚨 新增：存储当前的对话 ID。第一次请求后由后端返回并设置。
let currentConversationId = null; 
// 🚨 新增：用于本地请求中止和发送给后端的取消信号。
let currentAbortController = null; 

// --- 3. UI 交互事件监听 ---

// 自动调整输入框大小
userInput.addEventListener("input", function () {
    this.style.height = "auto";
    this.style.height = this.scrollHeight + "px";
});

// 键盘事件：按 Enter 发送消息
userInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

// 鼠标事件：点击发送按钮发送消息
sendButton.addEventListener("click", sendMessage);

// 🚨 新增：取消按钮监听器
cancelButton.addEventListener("click", cancelGeneration);


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
    // 🚨 新增：显示取消按钮
    cancelButton.classList.add("visible"); 

    // 1. 将用户消息渲染到 UI
    addMessageToChat("user", message);

    // 2. 清理输入框并重置大小
    userInput.value = "";
    userInput.style.height = "auto";

    // 3. 显示正在输入指示器
    typingIndicator.classList.add("visible");

    // 4. (可选) 将用户消息添加到本地历史记录
    chatHistory.push({ role: "user", content: message });
    
    // 🚨 新增：创建 AbortController 实例用于管理请求的生命周期
    currentAbortController = new AbortController();

    try {
        // --- 5. 准备接收流式响应的 UI 元素 ---
        const assistantMessageEl = document.createElement("div");
        assistantMessageEl.className = "message assistant-message";
        assistantMessageEl.innerHTML = "<p></p>";
        chatMessages.appendChild(assistantMessageEl);

        chatMessages.scrollTop = chatMessages.scrollHeight;

        // --- 6. 准备发送给后端的数据 (修改) ---
        // 🚨 修改：不再发送完整的 chatHistory。
        // 而是发送当前消息和 conversationId，后端会从 KV 读取历史记录。
        const payload = {
            message: message, 
            conversationId: currentConversationId, // 第一次是 null，之后是有效的 ID
        };

        // --- 7. 发送 API 请求 (POST /api/chat) ---
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
            // 🚨 新增：绑定 AbortController
            signal: currentAbortController.signal, 
        });
        
        // 🚨 新增：从响应头捕获 Conversation ID
        const conversationIdHeader = response.headers.get("X-Conversation-Id");
        if (conversationIdHeader) {
            currentConversationId = conversationIdHeader; 
            console.log("New Conversation ID set:", currentConversationId);
        }

        // 错误处理：检查 HTTP 状态码
        if (!response.ok) {
            throw new Error(`API Request Failed: ${response.statusText}`);
        }

        // --- 8. 核心流式响应处理 ---
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let responseText = "";

        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            const chunk = decoder.decode(value, { stream: true });

            // 处理后端 Worker 发送的自定义 JSON 流
            const lines = chunk.split("\n");
            for (const line of lines) {
                if (!line.trim()) continue;

                try {
                    const jsonData = JSON.parse(line);
                    
                    if (jsonData.response) {
                        responseText += jsonData.response;
                        assistantMessageEl.querySelector("p").textContent = responseText;
                        chatMessages.scrollTop = chatMessages.scrollHeight;
                    }
                } catch (e) {
                    // 忽略 JSON 解析错误
                }
            }
        }

        // --- 9. 流式响应结束后 ---
        // 将 AI 的完整回复添加到本地历史记录
        chatHistory.push({ role: "assistant", content: responseText });
    } catch (error) {
        // 🚨 异常处理：区分用户取消和实际错误
        if (error.name === 'AbortError') {
             assistantMessageEl.querySelector("p").textContent += "\n\n(Generation cancelled by user.)";
             console