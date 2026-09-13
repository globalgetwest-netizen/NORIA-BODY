/**
 * NORIA EMBODIMENT LAYER — intention parser + command executor.
 *
 * The Engine returns plain text (and we never change that). Here, in the Body,
 * we (a) infer Noria's *intention* from her words and conversation phase, and
 * (b) translate the small, stable command set (see EMBODIMENT.md) into calls on
 * whatever body is attached — today a NoriaFace, tomorrow a rigged avatar or the
 * physical NORIA-01 head. Only this executor changes when the body changes.
 */
export class Embodiment {
  constructor(face) { this.face = face }

  // Execute one embodiment command. This is the contract the hardware implements.
  execute(cmd) {
    const f = this.face
    switch (cmd.type) {
      case 'LOOK_AT': f.lookAt(cmd.x ?? 0, cmd.y ?? 0); break
      case 'BLINK': f.blink(!!cmd.double); break
      case 'SET_EXPRESSION': f.setExpression(cmd.expression || 'neutral'); break
      case 'TURN_HEAD': f.turnHead(cmd.yaw || 0, cmd.pitch || 0); break
      case 'GESTURE': f.gesture(cmd.kind || 'nod'); break
      case 'LISTEN': f.setListening(!!cmd.on); break
      case 'SPEAK': /* voice handled by Brain; face visemes toggled via setSpeaking */ break
      case 'IDLE': f.setExpression('neutral'); f.lookAt(0, 0); break
      default: break
    }
  }

  // Classify the feeling in Noria's reply → { emotion, expression, gesture }.
  // Shared by the face (expression/energy) and the voice (prosody).
  classify(text = '') {
    const t = text.toLowerCase()
    if (/\b(hello|hi|hey|welcome|good (morning|afternoon|evening)|greetings|nice to meet)\b/.test(t)) return { emotion: 'joy', expression: 'smile', gesture: 'greet' }
    if (/\b(congratulations|wonderful|excellent|great news|so happy|thrilled|approved|success|delighted|exciting)\b/.test(t)) return { emotion: 'joy', expression: 'smile', gesture: 'nod' }
    if (/\b(sorry|apolog|unfortunately|i can'?t|cannot|i understand how|that must be|stressful|worried|difficult|hard time|refus|denied|rejected)\b/.test(t)) return { emotion: 'concern', expression: 'concerned', gesture: null }
    if (/\?\s*$/.test(text.trim()) || /\b(could you|can you|would you like|tell me more|what kind|which one|how about)\b/.test(t)) return { emotion: 'warm', expression: 'curious', gesture: 'tilt' }
    if (/\b(glad|happy to|of course|absolutely|certainly|wonderful)\b/.test(t)) return { emotion: 'warm', expression: 'smile', gesture: 'nod' }
    if (/\b(no|not|never|incorrect)\b/.test(t)) return { emotion: 'neutral', expression: 'neutral', gesture: 'shake' }
    return { emotion: 'warm', expression: 'neutral', gesture: null }
  }

  // Just the emotion label (for voice prosody).
  emotionFor(text = '') { return this.classify(text).emotion }

  // Derive intention from Noria's reply text + phase, emit commands.
  // phase: 'thinking' | 'speaking' | 'idle'
  react(text = '', phase = 'idle') {
    if (phase === 'thinking') { this.execute({ type: 'SET_EXPRESSION', expression: 'thinking' }); return }
    if (phase === 'idle') { this.execute({ type: 'IDLE' }); return }

    const { expression, gesture } = this.classify(text)
    this.execute({ type: 'SET_EXPRESSION', expression })
    this.execute({ type: 'LOOK_AT', x: 0, y: 0 }) // hold the person's gaze while speaking
    if (gesture) this.execute({ type: 'GESTURE', kind: gesture })
  }
}
