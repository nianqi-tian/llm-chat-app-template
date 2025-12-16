/**
 * LLM Chat App Frontend (最终修正 V3：强制启动和流式兼容)
 */

// --- DOM elements ---
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const conversationList = document.getElementById('conversation-list');
const newChatButton = document.getElementById('new-chat-button');
const stopButton = document.getElementById('stop-button'); 
const webSearchToggle = document.getElementById('web-search-toggle');

// --- Chat state ---
let chatHistory = []; 
let isProcessing = false;
let currentConversationId = null; 
let conversationIndex = []; // 多会话索引：[{ id, title, updatedAt }]
const CONVERSATION_STORAGE_KEY = 'chat_conversations_v1';

const STARTUP_MESSAGE = "Hello! I'm an LLM chat app powered by Cloudflare Workers AI. How can I help you today?";


// --- 事件监听 (保持不变) ---
userInput.addEventListener("input", function () {
    this.style.height = "auto";
    this.style.height = this.scrollHeight + "px";
});

userInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

sendButton.addEventListener("click", sendMessage);
stopButton.addEventListener('click', stopGenerating);


// --- 核心函数：发送和接收消息 ---

async function stopGenerating() {
    if (!isProcessing || !currentConversationId) return;

    try {
        await fetch(`/api/chat/${currentConversationId}/cancel`, { method: "POST" });
    } catch (error) {
        console.error("Error sending cancel signal:", error);
    } finally {
        cleanUpAfterProcessing(true);
        addMessageToChat("system", "AI 生成已取消。", true);
    }
}


function cleanUpAfterProcessing(isCancelled = false) {
    isProcessing = false;
    typingIndicator.classList.remove("visible");
    userInput.disabled = false;
    sendButton.disabled = false;
    stopButton.classList.remove('visible');
    userInput.focus();
    
    // 成功完成一次对话轮次后，重新渲染侧边栏，让当前会话出现在历史列表中
    if (!isCancelled) {
        renderHistorySidebar(false); 
    }
}


async function sendMessage() {
    const message = userInput.value.trim();
    if (message === "" || isProcessing) return;

    const prevConversationId = currentConversationId;
    const isNewConversation = !prevConversationId;

    isProcessing = true;
    userInput.disabled = true;
    sendButton.disabled = true;
    stopButton.classList.add('visible');

    // 将本轮用户消息加入内存中的 chatHistory，便于生成侧边栏标题
    chatHistory.push({ role: 'user', content: message });
    addMessageToChat("user", message);

    userInput.value = "";
    userInput.style.height = "auto";

    typingIndicator.classList.add("visible");
    
    try {
        const assistantMessageEl = document.createElement("div");
        assistantMessageEl.className = "message assistant-message";
        assistantMessageEl.innerHTML = "<p></p>";
        chatMessages.appendChild(assistantMessageEl);
        chatMessages.scrollTop = chatMessages.scrollHeight;

        const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                messages: [{ role: "user", content: message }], 
                // 确保发送 null 或 UUID 字符串
                conversationId: currentConversationId,
                options: {
                    webSearchEnabled: !!(webSearchToggle && webSearchToggle.checked),
                },
            }),
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }
        
        const newId = response.headers.get('X-Conversation-ID');
        if (newId) {
            currentConversationId = newId;
            console.log("Set/Updated Conversation ID:", currentConversationId);
        }

        // 最终流处理逻辑：直接拼接文本块
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let responseText = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            
            responseText += chunk;
            assistantMessageEl.querySelector("p").textContent = responseText;
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }

        // 成功后，更新会话索引 + 侧边栏
        upsertConversationIndex(currentConversationId, message, isNewConversation);
        cleanUpAfterProcessing();
        
    } catch (error) {
        console.error("Error:", error);
        addMessageToChat("assistant", "Sorry, there was an error processing your request.",);
        cleanUpAfterProcessing(true);
    }
}


function addMessageToChat(role, content, isSystem = false, isInterrupted = false) {
    const messageEl = document.createElement("div");
    messageEl.className = `message ${role}-message ${isSystem ? 'system-message' : ''}`;
    let displayContent = content;
    if (role === 'assistant' && isInterrupted) {
        displayContent += '（已中断）';
    }
    messageEl.innerHTML = `<p>${displayContent}</p>`;
    chatMessages.appendChild(messageEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}


// ----------------------------------------------------
// --- 多会话历史管理（本地持久化） ---
// ----------------------------------------------------

function loadConversationIndexFromStorage() {
    try {
        const raw = localStorage.getItem(CONVERSATION_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed;
    } catch (e) {
        console.error('Failed to load conversation index from storage:', e);
        return [];
    }
}

function saveConversationIndexToStorage() {
    try {
        localStorage.setItem(CONVERSATION_STORAGE_KEY, JSON.stringify(conversationIndex));
    } catch (e) {
        console.error('Failed to save conversation index to storage:', e);
    }
}

function upsertConversationIndex(conversationId, firstUserMessageText, isNewConversation) {
    if (!conversationId) return;

    const existingIndex = conversationIndex.findIndex(c => c.id === conversationId);
    const now = Date.now();

    if (existingIndex === -1) {
        const titleBase = firstUserMessageText || '新对话';
        const title = titleBase.length > 30 ? (titleBase.substring(0, 30) + '...') : titleBase;
        conversationIndex.push({
            id: conversationId,
            title,
            updatedAt: now,
        });
    } else {
        conversationIndex[existingIndex].updatedAt = now;
        if (isNewConversation && firstUserMessageText) {
            // 如果是新对话首次出现，也可以根据第一条消息更新标题
            const titleBase = firstUserMessageText;
            const title = titleBase.length > 30 ? (titleBase.substring(0, 30) + '...') : titleBase;
            conversationIndex[existingIndex].title = title;
        }
    }

    // 将最近的会话排在最上面
    conversationIndex.sort((a, b) => b.updatedAt - a.updatedAt);
    saveConversationIndexToStorage();
    renderHistorySidebar(false);
}

async function renderHistorySidebar(highlightOnly = false) {
    if (highlightOnly) {
        document.querySelectorAll('.history-item').forEach(el => el.classList.remove('selected'));
        if (currentConversationId) {
            document.getElementById(`item-${currentConversationId}`)?.classList.add('selected');
        } else {
            document.getElementById('new-chat-placeholder')?.classList.add('selected');
        }
        return;
    }
    
    conversationList.innerHTML = ''; 

    // 渲染会话列表
    conversationIndex.forEach(conv => {
        const itemEl = document.createElement('div');
        itemEl.id = `item-${conv.id}`;
        itemEl.className = `history-item ${conv.id === currentConversationId ? 'selected' : ''}`;
        itemEl.innerHTML = `<div>${conv.title}</div>`;
        itemEl.addEventListener('click', () => {
            loadConversation(conv.id);
        });
        conversationList.appendChild(itemEl);
    });
    
    // 渲染“新建对话”提示
    const newItemEl = document.createElement('div');
    newItemEl.id = 'new-chat-placeholder';
    newItemEl.className = `history-item ${!currentConversationId ? 'selected' : ''}`; 
    newItemEl.innerHTML = `<div>+ 新建聊天</div>`;
    newItemEl.addEventListener('click', addNewConversation);
    conversationList.appendChild(newItemEl);
}


async function loadConversation(conversationId) {
    if (isProcessing) return;
    
    try {
        const response = await fetch(`/api/history?id=${conversationId}`);
        const data = await response.json();
        
        currentConversationId = conversationId;
        chatHistory = data.history || []; 
        
        chatMessages.innerHTML = '';
        chatHistory.forEach(msg => {
            if (msg.role !== 'system') {
                 addMessageToChat(msg.role, msg.content, false, !!msg.interrupted);
            }
        });
        
        renderHistorySidebar(true);

    } catch (error) {
        console.error("Error loading conversation:", error);
    }
}

function addNewConversation() {
    // 仅重置当前输入区和聊天窗口，不清空历史索引
    currentConversationId = null; // 🚨 核心：重置 ID 为 null
    chatHistory = []; 
    chatMessages.innerHTML = ''; 
    addMessageToChat("assistant", STARTUP_MESSAGE);
    userInput.focus();
    renderHistorySidebar(false); // 重新渲染，将“新建聊天”设为选中
}


// --- 初始化 ---

document.addEventListener('DOMContentLoaded', () => {
    newChatButton.addEventListener('click', addNewConversation);

    // 初始化会话索引（从 localStorage 恢复）
    conversationIndex = loadConversationIndexFromStorage();

    if (conversationIndex.length > 0) {
        // 如果有历史会话，加载最近一条
        renderHistorySidebar(false);
        loadConversation(conversationIndex[0].id);
    } else {
        // 否则开启一个新的空对话
        addNewConversation(); 
    }
});