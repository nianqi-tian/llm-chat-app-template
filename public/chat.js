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
    
    if (!isCancelled) {
        renderHistorySidebar(true); 
    }
}


async function sendMessage() {
    const message = userInput.value.trim();
    if (message === "" || isProcessing) return;

    isProcessing = true;
    userInput.disabled = true;
    sendButton.disabled = true;
    stopButton.classList.add('visible');

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

        // 成功后，更新侧边栏
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
// --- 历史记录管理函数 ---
// ----------------------------------------------------

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

    // 假设当前对话是唯一的列表项
    if (currentConversationId) {
        // 使用内存中的 chatHistory 来生成标题
        const userMessage = chatHistory.find(msg => msg.role === 'user');
        const title = userMessage ? (userMessage.content.substring(0, 30) + '...') : '新对话 (点击继续)';
        
        const itemEl = document.createElement('div');
        itemEl.id = `item-${currentConversationId}`;
        // 🚨 修正：始终选中当前对话
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
    // 🚨 修正：如果 currentConversationId 是 null，选中“新建聊天”
    newItemEl.className = `history-item ${!currentConversationId ? 'selected' : ''}`; 
    newItemEl.innerHTML = `<div>+ 新建聊天</div>`;
    newItemEl.addEventListener('click', addNewConversation);
    conversationList.appendChild(newItemEl);
}


async function loadConversation(conversationId) {
    if (isProcessing || conversationId === currentConversationId) return;
    
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
    currentConversationId = null; // 🚨 核心：重置 ID 为 null
    chatHistory = []; 
    chatMessages.innerHTML = ''; 
    addMessageToChat("assistant", STARTUP_MESSAGE);
    userInput.focus();
    renderHistorySidebar(); // 重新渲染，将“新建聊天”设为选中
}


// --- 初始化 ---

document.addEventListener('DOMContentLoaded', () => {
    newChatButton.addEventListener('click', addNewConversation);

    // 🚨 修正：使用 addNewConversation 作为唯一的启动入口
    addNewConversation(); 
});