/**
 * LLM Chat App Frontend (Integrated with KV History and Continue Conversation)
 *
 * Handles the chat UI interactions, history loading, and communication with the backend API.
 */

// --- DOM elements ---
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const conversationList = document.getElementById('conversation-list');
const newChatButton = document.getElementById('new-chat-button');
const stopButton = document.getElementById('stop-button'); // 新增取消按钮引用

// --- Chat state ---
let chatHistory = []; 
let isProcessing = false;
let currentConversationId = null; // 默认为空，表示新对话
let initialMessageDisplayed = false; 

const STARTUP_MESSAGE = "Hello! I'm an LLM chat app powered by Cloudflare Workers AI. How can I help you today?";


// --- 事件监听 ---

// Auto-resize textarea as user types
userInput.addEventListener("input", function () {
    this.style.height = "auto";
    this.style.height = this.scrollHeight + "px";
});

// Send message on Enter (without Shift)
userInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

// Send button click handler
sendButton.addEventListener("click", sendMessage);

// Stop button click handler
stopButton.addEventListener('click', stopGenerating);


// --- 核心函数：发送和接收消息 ---

/**
 * 停止当前的 AI 生成请求
 */
async function stopGenerating() {
    if (!isProcessing || !currentConversationId) return;

    // 发送取消请求到后端
    try {
        await fetch(`/api/chat/${currentConversationId}/cancel`, {
            method: "POST",
        });
        console.log("Cancellation signal sent.");
    } catch (error) {
        console.error("Error sending cancel signal:", error);
    } finally {
        // 无论后端是否成功，前端都清理状态
        cleanUpAfterProcessing(true);
        // 在聊天区域显示取消提示
        addMessageToChat("system", "AI 生成已取消。", true);
    }
}


/**
 * 统一清理状态和启用输入
 */
function cleanUpAfterProcessing(isCancelled = false) {
    isProcessing = false;
    typingIndicator.classList.remove("visible");
    userInput.disabled = false;
    sendButton.disabled = false;
    stopButton.classList.remove('visible'); // 隐藏停止按钮
    userInput.focus();
    
    // 如果没有取消，渲染历史记录，以便新的对话被添加到侧边栏
    if (!isCancelled) {
        renderHistorySidebar(true);
    }
}


/**
 * Sends a message to the chat API and processes the response
 */
async function sendMessage() {
    const message = userInput.value.trim();

    // Don't send empty messages or process if already busy
    if (message === "" || isProcessing) return;

    // 状态切换到处理中
    isProcessing = true;
    userInput.disabled = true;
    sendButton.disabled = true;
    stopButton.classList.add('visible'); // 显示停止按钮

    // 添加用户消息到聊天 UI
    addMessageToChat("user", message);

    // 清空输入
    userInput.value = "";
    userInput.style.height = "auto";

    // 显示打字指示器
    typingIndicator.classList.add("visible");
    
    // ⚠️ 注意：我们不再向内存 chatHistory push 消息，因为后端会在流结束后返回完整保存。
    // 我们只需要将最新的用户消息发送给后端。

    try {
        // 创建新的 assistant 消息元素
        const assistantMessageEl = document.createElement("div");
        assistantMessageEl.className = "message assistant-message";
        assistantMessageEl.innerHTML = "<p></p>";
        chatMessages.appendChild(assistantMessageEl);

        // 滚动到底部
        chatMessages.scrollTop = chatMessages.scrollHeight;

        // 发送请求到 API
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                // 只发送用户最新的消息
                messages: [{ role: "user", content: message }], 
                // 发送当前的 ID (如果存在，用于继续对话)
                conversationId: currentConversationId, 
            }),
        });

        // 错误处理
        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }
        
        // 🚨 从响应头中获取新的对话ID
        const newId = response.headers.get('X-Conversation-ID');
        if (newId) {
            currentConversationId = newId;
            console.log("Set/Updated Conversation ID:", currentConversationId);
        }

        // 处理流式响应
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let responseText = "";

        while (true) {
            const { done, value } = await reader.read();

            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            
            // ⚠️ 由于 Workers AI 返回的原始流格式可能不是标准的 SSE 或简单文本
            // 这里我们采用最简单的拼接方式，假设后端返回的是文本块
            responseText += chunk;
            assistantMessageEl.querySelector("p").textContent = responseText;
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }

        // 流结束后，清理状态并渲染历史侧边栏
        cleanUpAfterProcessing();
        
    } catch (error) {
        console.error("Error:", error);
        addMessageToChat(
            "assistant",
            "Sorry, there was an error processing your request.",
        );
        cleanUpAfterProcessing(true);
    }
}


/**
 * Helper function to add message to chat
 */
function addMessageToChat(role, content, isSystem = false) {
    const messageEl = document.createElement("div");
    messageEl.className = `message ${role}-message ${isSystem ? 'system-message' : ''}`;
    messageEl.innerHTML = `<p>${content}</p>`;
    chatMessages.appendChild(messageEl);

    // 滚动到底部
    chatMessages.scrollTop = chatMessages.scrollHeight;
}


// ----------------------------------------------------
// --- 历史记录管理函数 ---
// ----------------------------------------------------

/**
 * 渲染侧边栏的历史记录列表 (P0)
 * ⚠️ 这是一个简化版本，它只显示当前对话
 * @param {boolean} highlightOnly - 是否只更新高亮状态，避免重新拉取列表
 */
async function renderHistorySidebar(highlightOnly = false) {
    if (highlightOnly) {
         document.querySelectorAll('.history-item').forEach(el => {
            el.classList.remove('selected');
        });
        document.getElementById(`item-${currentConversationId}`)?.classList.add('selected');
        return;
    }
    
    // ⚠️ 实际项目中，这里应调用 GET /api/history/list
    // 由于我们没有列表接口，我们仅显示当前 ID
    conversationList.innerHTML = ''; 

    if (currentConversationId) {
        const title = chatHistory.length > 0 ? chatHistory[0].content.substring(0, 30) + '...' : '新建对话...';
        
        const itemEl = document.createElement('div');
        itemEl.id = `item-${currentConversationId}`;
        itemEl.className = 'history-item selected';
        itemEl.innerHTML = `<div>${title}</div>`;
        itemEl.addEventListener('click', () => {
            loadConversation(currentConversationId);
        });
        conversationList.appendChild(itemEl);
    }
    
    // 渲染“新建对话”提示
    const newItemEl = document.createElement('div');
    newItemEl.id = 'new-chat-placeholder';
    newItemEl.className = 'history-item';
    newItemEl.innerHTML = `<div>+ 新建聊天</div>`;
    newItemEl.addEventListener('click', addNewConversation);
    conversationList.appendChild(newItemEl);
}


/**
 * 加载特定对话ID的完整历史记录到主聊天区域 (P0)
 */
async function loadConversation(conversationId) {
    if (isProcessing) return;
    
    try {
        const response = await fetch(`/api/history?id=${conversationId}`);
        
        if (!response.ok) {
            throw new Error('Failed to fetch conversation history');
        }

        const data = await response.json();
        
        // 1. 更新全局状态
        currentConversationId = conversationId;
        chatHistory = data.history || []; 
        
        // 2. 清空聊天区域并重新渲染
        chatMessages.innerHTML = '';
        chatHistory.forEach(msg => {
            // 排除系统消息，只显示 user 和 assistant
            if (msg.role !== 'system') {
                 addMessageToChat(msg.role, msg.content);
            }
        });
        
        // 3. 更新侧边栏选中状态
        renderHistorySidebar(true);

        console.log(`Loaded conversation: ${conversationId}`);

    } catch (error) {
        console.error("Error loading conversation:", error);
        alert('无法加载历史记录。');
    }
}

/**
 * 清空状态，开始新的对话 (P0)
 */
function addNewConversation() {
    currentConversationId = null;
    chatHistory = []; 
    chatMessages.innerHTML = ''; 
    addMessageToChat("assistant", STARTUP_MESSAGE);
    initialMessageDisplayed = true;
    userInput.focus();
    renderHistorySidebar(true); // 清除高亮
}


// --- 初始化 ---

document.addEventListener('DOMContentLoaded', () => {
    // 绑定新建聊天按钮
    newChatButton.addEventListener('click', addNewConversation);

    // 默认显示起始消息
    if (!initialMessageDisplayed) {
        addMessageToChat("assistant", STARTUP_MESSAGE);
        initialMessageDisplayed = true;
    }
    
    // 渲染历史记录侧边栏
    renderHistorySidebar(); 
});