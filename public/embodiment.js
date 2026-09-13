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

  // Derive intention from Noria's reply text + phase, emit commands.
  // phase: 'thinking' | 'speaking' | 'idle'
  react(text = '', phase = 'idle') {
    if (phase === 'thinking') { this.execute({ type: 'SET_EXPRESSION', expression: 'thinking' }); return }
    if (phase === 'idle') { this.execute({ type: 'IDLE' }); return }

    const t = text.toLowerCase()
    let expression = 'neutral'
    let gesture = null
    if (/\b(hello|hi|hey|welcome|good (morning|afternoon|evening)|greetings|nice to meet)\b/.test(t)) { expression = 'smile'; gesture = 'greet' }
    else if (/\b(sorry|apolog|unfortunately|i can'?t|cannot|difficult|concern|careful|risk|warning)\b/.test(t)) expression = 'concerned'
    else if (/\?\s*$/.test(text.trim()) || /\b(could you|can you|would you like|which|what kind|tell me more)\b/.test(t)) { expression = 'curious'; gesture = 'tilt' }
    else if (/\b(great|excellent|congratulations|wonderful|happy|glad|success|approved|good news)\b/.test(t)) { expression = 'smile'; gesture = 'nod' }
    else if (/\b(yes|correct|exactly|absolutely|of course|certainly)\b/.test(t)) gesture = 'nod'
    else if (/\b(no|not|never|incorrect)\b/.test(t)) gesture = 'shake'

    this.execute({ type: 'SET_EXPRESSION', expression })
    this.execute({ type: 'LOOK_AT', x: 0, y: 0 }) // return gaze to the person while speaking
    if (gesture) this.execute({ type: 'GESTURE', kind: gesture })
  }
}
