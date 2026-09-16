import type {
  GeminiAdapter,
  GeminiModelCatalog,
  GeminiPromptResult,
  GeminiPromptRunInput,
  ResolvedGeminiModel,
} from "../gemini/gemini.types.js";

const FAKE_PROVIDER_ORIGIN = "https://fake-provider.invalid";
const FAKE_REPLY = "V16_E2E_REPLY";
const FAKE_MODEL: GeminiModelCatalog = {
  models: [{ key: "fake-model", label: "Fake Provider", selected: true, disabled: false }],
  currentModelKey: "fake-model",
};

/**
 * 仅供本地 Browser E2E 使用的 Provider 实现。
 * 不接收 BrowserManager，不读取 Cookie/Profile/API key，也不进行任何网络调用。
 */
export class E2EFakeGeminiAdapter implements GeminiAdapter {
  private conversationSequence = 0;

  async openConversation(_existingUrl: string | null): Promise<void> {}

  async runPrompt(input: GeminiPromptRunInput): Promise<GeminiPromptResult> {
    const conversationUrl =
      input.existingUrl ??
      `${FAKE_PROVIDER_ORIGIN}/app/v16e2e${(++this.conversationSequence).toString(16).padStart(10, "0")}`;
    await input.onConversationUrl(conversationUrl);
    await input.onText?.(FAKE_REPLY);
    return {
      answer: FAKE_REPLY,
      conversationUrl,
      urlDetectedElapsedMs: 0,
      answerElapsedMs: 0,
    };
  }

  async confirmIdle(): Promise<boolean> {
    return true;
  }

  async listModels(): Promise<GeminiModelCatalog> {
    return FAKE_MODEL;
  }

  async ensureModel(requestedModelKey: string, signal?: AbortSignal): Promise<ResolvedGeminiModel> {
    signal?.throwIfAborted();
    return { key: requestedModelKey, label: requestedModelKey };
  }
}

export { FAKE_REPLY };
