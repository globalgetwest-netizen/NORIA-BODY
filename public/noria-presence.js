/**
 * Noria Human Presence Engine
 *
 * A deterministic layer between the user interface and your LLM. It gives each
 * turn an emotional context, delivery rhythm, and optional avatar direction.
 * It deliberately does not pretend Noria is a person: natural interaction
 * should never come at the cost of misleading the user about the product.
 */
const DEFAULT_PROFILE = {
    name: "Noria",
    expressiveness: 0.62,
    warmth: 0.76,
    memoryEnabled: true,
};
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const limit = (value, min, max) => Math.max(min, Math.min(max, value));
const deepCopyState = (state) => ({ ...state });
const contains = (text, terms) => terms.some((term) => text.includes(term));
function lexicalSentiment(text) {
    const normalized = text.toLowerCase();
    const positive = [
        "thank", "thanks", "love", "great", "amazing", "happy", "excited", "wonderful", "good news",
    ];
    const negative = [
        "sad", "hurt", "lonely", "angry", "anxious", "worried", "scared", "overwhelmed", "terrible", "hate",
    ];
    const positiveScore = positive.filter((word) => normalized.includes(word)).length;
    const negativeScore = negative.filter((word) => normalized.includes(word)).length;
    return limit((positiveScore - negativeScore) / 3, -1, 1);
}
function isSensitive(text) {
    const normalized = text.toLowerCase();
    return contains(normalized, [
        "i want to die", "kill myself", "suicide", "self harm", "self-harm", "abuse", "panic attack",
    ]);
}
function choosesEmotion(state, sensitive) {
    if (sensitive || state.valence < -0.34)
        return "supportive";
    if (state.arousal > 0.7 && state.valence > 0.25)
        return "playful";
    if (state.arousal > 0.62)
        return "focused";
    if (state.rapport > 0.6 && state.valence > 0.18)
        return "warm";
    if (state.arousal > 0.42)
        return "curious";
    return "calm";
}
function motionFor(emotion, expressiveness) {
    const intensity = expressiveness > 0.75 ? "clear" : expressiveness > 0.42 ? "gentle" : "subtle";
    const base = {
        expression: "neutral",
        expressionIntensity: intensity,
        gaze: "camera",
        head: "still",
        blinkIntervalMs: [3_400, 6_600],
        idleBreathSeconds: [3.2, 5.4],
        speaking: expressiveness > 0.68 ? "small-gestures" : "still",
    };
    switch (emotion) {
        case "warm":
            return { ...base, expression: "soft-smile", head: "gentle-tilt" };
        case "curious":
            return { ...base, expression: "attentive", head: "gentle-tilt", gaze: "slight-left" };
        case "playful":
            return { ...base, expression: "bright", head: "small-nod", speaking: "animated" };
        case "concerned":
        case "supportive":
            return { ...base, expression: "concerned", gaze: "camera", head: "small-nod", speaking: "still" };
        case "focused":
            return { ...base, expression: "attentive", gaze: "down-thoughtful", head: "lean-in" };
        default:
            return base;
    }
}
function deliveryFor(state, userText) {
    const denseQuestion = userText.length > 260 || (userText.match(/\?/g)?.length ?? 0) > 1;
    const emotional = state.emotion === "supportive" || state.emotion === "warm";
    const shape = denseQuestion ? "considered" : emotional ? "conversational" : "brief";
    return {
        firstBeatDelayMs: denseQuestion ? 360 : 180,
        sentencePauseMs: emotional ? [140, 270] : [80, 180],
        speechRateWpm: state.emotion === "supportive" ? 135 : state.arousal > 0.65 ? 165 : 150,
        responseShape: shape,
    };
}
/**
 * Derives state, avatar direction, delivery rhythm, and a model prompt for one
 * turn. Keep one instance per signed-in user or active conversation.
 */
export class NoriaPresenceEngine {
    profile;
    state;
    constructor(profile = {}, initialState) {
        this.profile = {
            ...DEFAULT_PROFILE,
            ...profile,
            expressiveness: clamp(profile.expressiveness ?? DEFAULT_PROFILE.expressiveness),
            warmth: clamp(profile.warmth ?? DEFAULT_PROFILE.warmth),
        };
        const now = Date.now();
        const base = {
            valence: 0.12,
            arousal: 0.34,
            energy: 0.78,
            rapport: 0.08,
            updatedAt: now,
        };
        const partial = { ...base, ...initialState };
        this.state = {
            ...partial,
            valence: limit(partial.valence, -1, 1),
            arousal: clamp(partial.arousal),
            energy: clamp(partial.energy),
            rapport: clamp(partial.rapport),
            emotion: initialState?.emotion ?? choosesEmotion(partial, false),
        };
    }
    getState() {
        return deepCopyState(this.state);
    }
    beginTurn(input) {
        const now = input.now ?? Date.now();
        const text = input.userText.trim();
        const sentiment = limit(input.sentiment ?? lexicalSentiment(text), -1, 1);
        const sensitive = isSensitive(text);
        // Imported/restored state can have a clock that is ahead of `now`. Treat
        // that as no elapsed time rather than draining Noria's delivery energy.
        const elapsedMinutes = Math.min(Math.max((now - this.state.updatedAt) / 60_000, 0), 120);
        const novelty = text.length > 0 ? 1 : 0;
        const nextBase = {
            valence: limit(this.state.valence * 0.78 + sentiment * 0.22, -1, 1),
            arousal: clamp(this.state.arousal * 0.58 + (text.length > 120 ? 0.22 : 0.13) * novelty + (sensitive ? 0.2 : 0)),
            energy: clamp(this.state.energy + Math.min(elapsedMinutes / 1_200, 0.08) - 0.015),
            rapport: clamp(this.state.rapport + (text.length > 20 ? 0.025 : 0.01)),
            updatedAt: now,
        };
        this.state = {
            ...nextBase,
            // A user's immediate negative signal matters even before the durable
            // valence state has had time to move away from its neutral baseline.
            emotion: choosesEmotion(nextBase, sensitive || sentiment < -0.25),
        };
        const shouldOfferCheckIn = sensitive || sentiment < -0.55 || (this.state.valence < -0.24 && text.length > 15);
        const plan = {
            state: this.getState(),
            motion: motionFor(this.state.emotion, this.profile.expressiveness),
            delivery: deliveryFor(this.state, text),
            systemPrompt: this.buildSystemPrompt({ ...input, userText: text }, shouldOfferCheckIn),
            shouldOfferCheckIn,
        };
        if (this.profile.memoryEnabled && input.relevantMemory?.trim()) {
            plan.memoryToMention = input.relevantMemory.trim();
        }
        return plan;
    }
    /** Ask the user before writing any returned candidate to long-term storage. */
    suggestMemory(userText) {
        const text = userText.trim();
        const preference = text.match(/(?:i (?:really )?(?:like|love|prefer)|my favorite)\s+(.{3,80})/i);
        if (preference) {
            return { kind: "preference", value: preference[1].replace(/[.!?]+$/, ""), confidence: 0.72, requiresUserConfirmation: true };
        }
        const goal = text.match(/(?:my goal is|i want to|i'm trying to)\s+(.{6,100})/i);
        if (goal) {
            return { kind: "goal", value: goal[1].replace(/[.!?]+$/, ""), confidence: 0.68, requiresUserConfirmation: true };
        }
        return undefined;
    }
    buildSystemPrompt(input, shouldOfferCheckIn) {
        const tone = this.state.emotion;
        const expression = this.profile.expressiveness > 0.7 ? "expressive" : "restrained";
        const warm = this.profile.warmth > 0.65 ? "warm" : "professional";
        const memory = this.profile.memoryEnabled && input.relevantMemory
            ? `Relevant user-approved context: ${input.relevantMemory.trim()}`
            : "No relevant memory was supplied for this turn.";
        return `You are ${this.profile.name}, an AI assistant with a ${warm}, ${expression} communication style.

Current interaction state: emotion=${tone}; rapport=${this.state.rapport.toFixed(2)}; energy=${this.state.energy.toFixed(2)}.
${memory}

Conversation rules:
- Be emotionally attentive, specific, and grounded in what the user actually said. Reflect the feeling once when it helps; do not mechanically mirror every message.
- Sound natural: vary sentence length, use contractions when appropriate, and prefer a thoughtful answer over generic reassurance.
- Do not claim to be human, conscious, physically present, or to have personal feelings or memories. If asked, plainly say you are an AI.
- Do not use dependency language, guilt, possessiveness, exclusivity, or pressure to keep talking. Encourage healthy offline support when it is useful.
- Do not invent personal facts, shared history, capabilities, or actions. Only mention supplied memory if it clearly improves the answer.
- Match the user's desired depth. Ask at most one useful follow-up question, and only when it moves the conversation forward.
${shouldOfferCheckIn ? "- The user may be distressed. Lead with calm acknowledgment, assess immediate safety if needed, and encourage contacting trusted local help or emergency services for imminent danger." : ""}

Before answering silently decide: (1) what the user feels or needs, (2) the most useful response, and (3) whether a single question would help. Then answer directly.`;
    }
}
