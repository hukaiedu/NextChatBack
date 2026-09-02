-- CreateTable
-- 手工补充:Conversation.status CHECK(ACTIVE/ARCHIVED/DELETED)
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE', 'ARCHIVED', 'DELETED')),
    "provider" TEXT NOT NULL DEFAULT 'GEMINI_WEB',
    "providerConversationUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);

-- CreateTable
-- 手工补充:Message.role CHECK(USER/ASSISTANT)、Message.status CHECK(六态)
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL CHECK ("role" IN ('USER', 'ASSISTANT')),
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL CHECK ("status" IN ('PENDING', 'STREAMING', 'COMPLETED', 'FAILED', 'CANCELLED')),
    "position" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
-- 手工补充:ModelRequest.status CHECK(七态)
CREATE TABLE "ModelRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "userMessageId" TEXT NOT NULL,
    "assistantMessageId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL CHECK ("status" IN ('PENDING', 'PROCESSING', 'CANCELLING', 'SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT')),
    "provider" TEXT NOT NULL DEFAULT 'GEMINI_WEB',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ModelRequest_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ModelRequest_userMessageId_fkey" FOREIGN KEY ("userMessageId") REFERENCES "Message" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ModelRequest_assistantMessageId_fkey" FOREIGN KEY ("assistantMessageId") REFERENCES "Message" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_providerConversationUrl_key" ON "Conversation"("providerConversationUrl");

-- CreateIndex
CREATE INDEX "Conversation_status_idx" ON "Conversation"("status");

-- CreateIndex
CREATE INDEX "Conversation_updatedAt_idx" ON "Conversation"("updatedAt");

-- CreateIndex
CREATE INDEX "Message_conversationId_idx" ON "Message"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_conversationId_position_key" ON "Message"("conversationId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ModelRequest_idempotencyKey_key" ON "ModelRequest"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ModelRequest_conversationId_idx" ON "ModelRequest"("conversationId");

-- CreateIndex
CREATE INDEX "ModelRequest_status_idx" ON "ModelRequest"("status");

-- 手工补充:同一个 Conversation 最多一个活动 Request(PENDING/PROCESSING/CANCELLING)
-- SQLite 不支持 Prisma partial index,此约束在 migration 中实现
CREATE UNIQUE INDEX "uk_active_request_per_conversation" ON "ModelRequest"("conversationId")
WHERE "status" IN ('PENDING', 'PROCESSING', 'CANCELLING');
