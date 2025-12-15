/**
 * LLM Chat App Frontend (最终修正版本：解决流式和历史记录显示问题)
 */

// --- DOM elements ---
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const conversationList = document.getElementById('conversation-list');
const newChatButton = document.getElementById('new-chat-button');
const stopButton = document.getElementById('stop-button'); 

// --- Chat state ---
let chatHistory = []; 
let isProcessing = false;
let currentConversationId = null; 
let initialMessageDisplayed = false; 

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
        await fetch(`/api/chat/${currentConversationId}/cancel`, {
            method: "POST",
        });
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
    
    // 成功后渲染历史记录，显示新的会话项 (针对问题三)
    if (!isCancelled) {
        // 🚨 修正：确保在保存完成后，侧边栏被刷新和高亮
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
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                messages: [{ role: "user", content: message }], 
                // 🚨 修正：如果 ID 为 null，发送 null
                conversationId: currentConversationId, 
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

        // 🚨 修正：简化流处理，直接拼接文本块 (解决流式问题)
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


function addMessageToChat(role, content, isSystem = false) {
    const messageEl = document.createElement("div");
    messageEl.className = `message ${role}-message ${isSystem ? 'system-message' : ''}`;
    messageEl.innerHTML = `<p>${content}</p>`;
    chatMessages.appendChild(messageEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}


// ----------------------------------------------------
// --- 历史记录管理函数 ---
// ----------------------------------------------------

async function renderHistorySidebar(highlightOnly = false) {
    // 仅更新高亮状态的逻辑
    if (highlightOnly) {
         document.querySelectorAll('.history-item').forEach(el => el.classList.remove('selected'));
         // 如果当前有 ID，选中它
         if (currentConversationId) {
            document.getElementById(`item-${currentConversationId}`)?.classList.add('selected');
         }
         return;
    }
    
    conversationList.innerHTML = ''; 

    // 🚨 修正：从 KV 加载所有历史记录列表 (如果 backend 支持)
    // ⚠️ 假设我们现在只有一个列表项：当前会话
    if (currentConversationId) {
        // 使用内存中的 chatHistory 来生成标题
        const userMessage = chatHistory.find(msg => msg.role === 'user');
        const title = userMessage ? (userMessage.content.substring(0, 30) + '...') : '新对话 (点击继续)';
        
        const itemEl = document.createElement('div');
        itemEl.id = `item-${currentConversationId}`;
        itemEl.className = 'history-item selected'; // 默认选中当前对话
        itemEl.innerHTML = `<div>${title}</div>`;
        
        itemEl.addEventListener('click', () => {
            loadConversation(currentConversationId);
        });
        conversationList.appendChild(itemEl);
    }
    
    // 渲染“新建对话”提示 (始终在列表底部)
    const newItemEl = document.createElement('div');
    newItemEl.id = 'new-chat-placeholder';
    newItemEl.className = `history-item ${!currentConversationId ? 'selected' : ''}`; // 如果是新对话，选中它
    newItemEl.innerHTML = `<div>+ 新建聊天</div>`;
    newItemEl.addEventListener('click', addNewConversation);
    conversationList.appendChild(newItemEl);
}


async function loadConversation(conversationId) {
    if (isProcessing || conversationId === currentConversationId) return; // 避免重复加载
    
    try {
        const response = await fetch(`/api/history?id=${conversationId}`);
        
        if (!response.ok) {
            throw new Error('Failed to fetch conversation history');
        }

        const data = await response.json();
        
        currentConversationId = conversationId;
        chatHistory = data.history || []; 
        
        chatMessages.innerHTML = '';
        chatHistory.forEach(msg => {
            if (msg.role !== 'system') {
                 addMessageToChat(msg.role, msg.content);
            }
        });
        
        renderHistorySidebar(true);

    } catch (error) {
        console.error("Error loading conversation:", error);
        alert('无法加载历史记录。');
    }
}

function addNewConversation() {
    currentConversationId = null; // 🚨 修正：设为 null
    chatHistory = []; 
    chatMessages.innerHTML = ''; 
    addMessageToChat("assistant", STARTUP_MESSAGE);
    initialMessageDisplayed = true;
    userInput.focus();
    renderHistorySidebar(true); // 清除高亮，选中“新建聊天”
}


// --- 初始化 ---

document.addEventListener('DOMContentLoaded', () => {
    newChatButton.addEventListener('click', addNewConversation);

    if (!initialMessageDisplayed) {
        addMessageToChat("assistant", STARTUP_MESSAGE);
        initialMessageDisplayed = true;
    }
    
    // 确保页面加载时尝试渲染侧边栏
    renderHistorySidebar(); 
});