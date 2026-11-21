import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

describe("Pi Durable smoke", () => {
  it("settles a scripted model turn", async () => {
    const faux = fauxProvider({ provider: "faux-test", models: [{ id: "faux-test", reasoning: false }] });
    faux.setResponses([fauxAssistantMessage([fauxText("READY")])]);

    const models = createModels();
    models.setProvider(faux.provider);
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    const model = faux.getModel();
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: model.provider, modelId: model.id }, thinkingLevel: "off", tools: [] },
    });

    const submission = await root.submit(
      { type: "input", content: "Return READY." },
      BACKGROUND_CONTEXT,
    );
    const settled = await submission.wait(BACKGROUND_CONTEXT);

    expect(settled.status).toBe("done");
    expect(faux.state.callCount).toBe(1);
    await harness.close(BACKGROUND_CONTEXT);
  });
});
