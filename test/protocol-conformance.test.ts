import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import {
  createGeometrySequenceGuard,
  createGeometryBatcher,
  createPlacementMessagePublisher,
  createSizeMessagePublisher,
  decodeGeometryWireValue,
  GEOMETRY_PROTOCOL_VERSION,
  type GeometryBatch,
  type GeometryMessage,
} from '../src/protocol.js'
import type { Placement } from '../src/types.js'

/**
 * Model-Based Property & Conformance Testing for view-anchor protocol.
 *
 * Directly mirrors the TLA+ formal specifications:
 *   - SequenceGuard.tla (MonotonicityWithinEpoch, HighWaterMarkConsistency)
 *   - GeometryBatcher.tla (PendingExceedsConfirmed, ReentrancyPreservation, GenerationIsolation)
 *   - ViewAnchorProtocol.tla (ReceiverMonotonicity, Soundness across reordering/lossy channels)
 *
 * Guarantees that the TypeScript implementation NEVER drifts from the TLA+ specification.
 */

describe('TLA+ Model-Based Conformance: SequenceGuard.tla', () => {
  it('guarantees MonotonicityWithinEpoch and drops stale/duplicate messages under arbitrary inputs', () => {
    const anchors = ['a1', 'a2'] as const
    const kinds = ['placement', 'size'] as const

    const messageArb = fc.record({
      anchorId: fc.constantFrom(...anchors),
      generation: fc.integer({ min: 0, max: 10 }),
      kind: fc.constantFrom(...kinds),
      seq: fc.integer({ min: 1, max: 20 }),
    })

    const actionArb = fc.oneof(
      fc.record({ type: fc.constant('accept'), message: messageArb }),
      fc.record({ type: fc.constant('clear'), anchorId: fc.constantFrom(...anchors, undefined) }),
    )

    fc.assert(
      fc.property(fc.array(actionArb, { minLength: 10, maxLength: 80 }), (actions) => {
        const guard = createGeometrySequenceGuard()

        // Track model state per anchor
        interface AnchorModel {
          epoch: number
          history: Array<{ gen: number; kind: 'placement' | 'size'; seq: number; epoch: number }>
          lastKnownGen: number | null
          pSeq: number
          sSeq: number
        }

        const model: Record<(typeof anchors)[number], AnchorModel> = {
          a1: { epoch: 0, history: [], lastKnownGen: null, pSeq: -1, sSeq: -1 },
          a2: { epoch: 0, history: [], lastKnownGen: null, pSeq: -1, sSeq: -1 },
        }

        for (const action of actions) {
          if (action.type === 'clear') {
            if (action.anchorId === undefined) {
              guard.clear()
              for (const a of anchors) {
                model[a].epoch++
                model[a].lastKnownGen = null
                model[a].pSeq = -1
                model[a].sSeq = -1
              }
            } else {
              guard.clear(action.anchorId)
              const m = model[action.anchorId]
              m.epoch++
              m.lastKnownGen = null
              m.pSeq = -1
              m.sSeq = -1
            }
            continue
          }

          const { anchorId, generation, kind, seq } = action.message
          const wireMsg: GeometryMessage =
            kind === 'placement'
              ? {
                  v: GEOMETRY_PROTOCOL_VERSION,
                  kind: 'placement',
                  anchorId,
                  generation,
                  seq,
                  placement: { visible: true, bounds: { x: 0, y: 0, width: 10, height: 10 } },
                }
              : {
                  v: GEOMETRY_PROTOCOL_VERSION,
                  kind: 'size',
                  anchorId,
                  generation,
                  seq,
                  size: { axis: 'block', extent: 10 },
                }

          const m = model[anchorId]
          const accepted = guard.accept(wireMsg)

          // Mathematical TLA+ Oracle decision:
          let expectedAccepted: boolean
          if (m.lastKnownGen === null || generation > m.lastKnownGen) {
            expectedAccepted = true
          } else if (generation < m.lastKnownGen) {
            expectedAccepted = false
          } else {
            // generation === m.lastKnownGen
            const currentSeq = kind === 'placement' ? m.pSeq : m.sSeq
            expectedAccepted = seq > currentSeq
          }

          // 1. Implementation decision matches TLA+ transition rule exactly
          expect(accepted).toBe(expectedAccepted)

          if (accepted) {
            // Update Oracle state (identical to TLA+ AcceptMessage)
            if (m.lastKnownGen === null || generation > m.lastKnownGen) {
              m.lastKnownGen = generation
              m.pSeq = kind === 'placement' ? seq : -1
              m.sSeq = kind === 'size' ? seq : -1
            } else {
              if (kind === 'placement') m.pSeq = seq
              else m.sSeq = seq
            }

            m.history.push({ gen: generation, kind, seq, epoch: m.epoch })

            // 2. Assert TLA+ Invariant: MonotonicityWithinEpoch
            const currentEpochHistory = m.history.filter((h) => h.epoch === m.epoch)
            for (let i = 0; i < currentEpochHistory.length - 1; i++) {
              const h1 = currentEpochHistory[i]!
              const h2 = currentEpochHistory[i + 1]!
              const strictlyMonotonic =
                h2.gen > h1.gen ||
                (h2.gen === h1.gen && (h1.kind === h2.kind ? h2.seq > h1.seq : true))
              expect(strictlyMonotonic).toBe(true)
            }

            // 3. Assert TLA+ Invariant: No duplicate in same generation and kind within epoch
            const duplicates = currentEpochHistory.filter(
              (h) => h.gen === generation && h.kind === kind && h.seq === seq,
            )
            expect(duplicates.length).toBe(1)
          }
        }
      }),
      { numRuns: 150 },
    )
  })
})

describe('TLA+ Model-Based Conformance: GeometryBatcher.tla', () => {
  it('preserves ReentrancyPreservation, ConfirmedSeqMonotonic, and GenerationIsolation', () => {
    const anchors = ['a1', 'a2'] as const

    interface BatcherAction {
      type: 'publish' | 'clear' | 'flush' | 'reentrantPublish' | 'reentrantClear'
      anchorId: (typeof anchors)[number]
      generation: number
      kind: 'placement' | 'size'
      seq: number
      shouldFailSend?: boolean
    }

    const actionArb: fc.Arbitrary<BatcherAction> = fc.record({
      type: fc.constantFrom('publish', 'clear', 'flush', 'reentrantPublish', 'reentrantClear'),
      anchorId: fc.constantFrom(...anchors),
      generation: fc.integer({ min: 0, max: 5 }),
      kind: fc.constantFrom('placement', 'size'),
      seq: fc.integer({ min: 1, max: 15 }),
      shouldFailSend: fc.boolean(),
    })

    fc.assert(
      fc.property(fc.array(actionArb, { minLength: 10, maxLength: 50 }), (actionList) => {
        let currentSendHandler: (batch: GeometryBatch) => boolean = () => true

        const batcher = createGeometryBatcher((batch) => {
          return currentSendHandler(batch)
        })

        const makeMsg = (
          anchorId: string,
          generation: number,
          kind: 'placement' | 'size',
          seq: number,
        ): GeometryMessage =>
          kind === 'placement'
            ? {
                v: GEOMETRY_PROTOCOL_VERSION,
                kind: 'placement',
                anchorId,
                generation,
                seq,
                placement: { visible: true, bounds: { x: 0, y: 0, width: 1, height: 1 } },
              }
            : {
                v: GEOMETRY_PROTOCOL_VERSION,
                kind: 'size',
                anchorId,
                generation,
                seq,
                size: { axis: 'block', extent: 1 },
              }

        const currentEpoch: Record<(typeof anchors)[number], number> = { a1: 0, a2: 0 }
        const publishedEpochs = new WeakMap<GeometryMessage, number>()
        const deliveredWithEpoch: Array<{ msg: GeometryMessage; epoch: number }> = []

        // Model state tracker directly mirroring GeometryBatcher.tla
        interface ModelAnchorState {
          g: number
          p?: GeometryMessage
          s?: GeometryMessage
          pSeq?: number
          sSeq?: number
          id: number
        }

        const modelAnchors: Record<(typeof anchors)[number], ModelAnchorState | undefined> = {
          a1: undefined,
          a2: undefined,
        }
        let nextModelId = 1

        const modelPublish = (msg: GeometryMessage) => {
          const a = msg.anchorId as (typeof anchors)[number]
          let st = modelAnchors[a]
          if (st !== undefined && msg.generation < st.g) return
          if (st === undefined || msg.generation > st.g) {
            st = {
              g: msg.generation,
              p: undefined,
              s: undefined,
              pSeq: undefined,
              sSeq: undefined,
              id: nextModelId++,
            }
            modelAnchors[a] = st
          }
          if (msg.kind === 'placement') {
            if (
              (st.p === undefined || msg.seq > st.p.seq) &&
              (st.pSeq === undefined || msg.seq > st.pSeq)
            ) {
              st.p = msg
            }
          } else {
            if (
              (st.s === undefined || msg.seq > st.s.seq) &&
              (st.sSeq === undefined || msg.seq > st.sSeq)
            ) {
              st.s = msg
            }
          }
        }

        const modelClear = (anchorId?: (typeof anchors)[number]) => {
          if (anchorId === undefined) {
            for (const a of anchors) modelAnchors[a] = undefined
          } else {
            modelAnchors[anchorId] = undefined
          }
        }

        const publishToBatcher = (msg: GeometryMessage) => {
          publishedEpochs.set(msg, currentEpoch[msg.anchorId as (typeof anchors)[number]] ?? 0)
          batcher.publish(msg)
        }

        const recordDelivered = (batch: GeometryBatch) => {
          for (const m of batch.messages) {
            deliveredWithEpoch.push({
              msg: m,
              epoch:
                publishedEpochs.get(m) ?? currentEpoch[m.anchorId as (typeof anchors)[number]] ?? 0,
            })
          }
        }

        const executeFlush = (shouldFailSend: boolean, reentrantCb?: () => void): boolean => {
          interface SnapshotItem {
            msg: GeometryMessage
            stateId: number
          }
          const expectedSnapshot: SnapshotItem[] = []
          for (const a of anchors) {
            const st = modelAnchors[a]
            if (!st) continue
            if (st.p !== undefined) expectedSnapshot.push({ msg: st.p, stateId: st.id })
            if (st.s !== undefined) expectedSnapshot.push({ msg: st.s, stateId: st.id })
          }

          let capturedBatch: GeometryBatch | undefined
          let sendInvoked = false
          let callbackError: unknown

          currentSendHandler = (batch) => {
            sendInvoked = true
            capturedBatch = batch

            if (reentrantCb) {
              try {
                reentrantCb()
              } catch (err) {
                callbackError = err
                throw err
              }
            }

            if (shouldFailSend) {
              return false
            }

            recordDelivered(batch)
            return true
          }

          const flushed = batcher.flush()

          if (callbackError) {
            throw callbackError
          }

          if (expectedSnapshot.length === 0) {
            expect(sendInvoked).toBe(false)
            expect(flushed).toBe(false)
          } else {
            expect(sendInvoked).toBe(true)
            expect(capturedBatch).toBeDefined()

            // Oracle Check: output batch must contain exactly the model's pending messages.
            // Verified OUTSIDE the send callback so try/catch in batcher never masks failures.
            expect(capturedBatch!.messages.length).toBe(expectedSnapshot.length)
            for (const item of expectedSnapshot) {
              const matched = capturedBatch!.messages.find(
                (m) =>
                  m.anchorId === item.msg.anchorId &&
                  m.kind === item.msg.kind &&
                  m.generation === item.msg.generation &&
                  m.seq === item.msg.seq,
              )
              expect(matched).toBeDefined()
            }

            if (shouldFailSend) {
              expect(flushed).toBe(false)
              // On failure, pending messages remain in model to be retried
            } else {
              expect(flushed).toBe(true)
              // On success, update model confirmed sequences and unset sent messages if identity matches
              for (const item of expectedSnapshot) {
                const st = modelAnchors[item.msg.anchorId as (typeof anchors)[number]]
                if (st !== undefined && st.id === item.stateId) {
                  if (item.msg.kind === 'placement') {
                    if (st.pSeq === undefined || item.msg.seq > st.pSeq) {
                      st.pSeq = item.msg.seq
                    }
                    if (st.p === item.msg) {
                      st.p = undefined
                    }
                  } else {
                    if (st.sSeq === undefined || item.msg.seq > st.sSeq) {
                      st.sSeq = item.msg.seq
                    }
                    if (st.s === item.msg) {
                      st.s = undefined
                    }
                  }
                }
              }
            }
          }

          return flushed
        }

        // Run actions, occasionally triggering reentrancy inside send()
        for (const act of actionList) {
          if (act.type === 'publish') {
            const msg = makeMsg(act.anchorId, act.generation, act.kind, act.seq)
            modelPublish(msg)
            publishToBatcher(msg)
          } else if (act.type === 'clear') {
            currentEpoch[act.anchorId]++
            modelClear(act.anchorId)
            batcher.clear(act.anchorId)
          } else if (act.type === 'flush') {
            executeFlush(act.shouldFailSend ?? false)
          } else if (act.type === 'reentrantPublish') {
            // Synchronous reentrancy during send()
            const reentrantMsg = makeMsg(act.anchorId, act.generation, act.kind, act.seq)
            executeFlush(act.shouldFailSend ?? false, () => {
              modelPublish(reentrantMsg)
              publishToBatcher(reentrantMsg)
            })
          } else if (act.type === 'reentrantClear') {
            // Reentrant clear during send()
            executeFlush(act.shouldFailSend ?? false, () => {
              currentEpoch[act.anchorId]++
              modelClear(act.anchorId)
              batcher.clear(act.anchorId)
            })
          }
        }

        // Final flush to drain any remaining retries
        executeFlush(false)

        // After final drain, subsequent flush must return false
        expect(batcher.flush()).toBe(false)

        // Verify TLA+ Invariant: ConfirmedSeqMonotonic on delivered messages within the same clear epoch
        for (const a of anchors) {
          for (const k of ['placement', 'size'] as const) {
            const anchorDelivered = deliveredWithEpoch.filter(
              (item) => item.msg.anchorId === a && item.msg.kind === k,
            )
            for (let i = 0; i < anchorDelivered.length - 1; i++) {
              const item1 = anchorDelivered[i]!
              const item2 = anchorDelivered[i + 1]!
              if (item1.epoch === item2.epoch && item1.msg.generation === item2.msg.generation) {
                // Within the same clear epoch and generation, sequence must never regress
                expect(item2.msg.seq).toBeGreaterThanOrEqual(item1.msg.seq)
              }
            }
          }
        }
      }),
      { numRuns: 100 },
    )
  })
})

describe('TLA+ Model-Based Conformance: ViewAnchorProtocol.tla', () => {
  it('guarantees ReceiverMonotonicity and Soundness over a reordering, duplicating, lossy channel', () => {
    const anchorId = 'view-target'

    interface NetworkPacket {
      raw: unknown
      order: number
    }

    const operationArb = fc.record({
      kind: fc.constantFrom('placement', 'size'),
      generation: fc.integer({ min: 0, max: 3 }),
      flushImmediately: fc.boolean(),
      reorderWeight: fc.integer({ min: 0, max: 1000 }),
      duplicate: fc.boolean(),
      drop: fc.boolean(),
    })

    fc.assert(
      fc.property(fc.array(operationArb, { minLength: 15, maxLength: 60 }), (ops) => {
        const packetsInFlight: NetworkPacket[] = []

        // 1. Batcher setup connected to simulated network
        let nextOrder = 0
        const batcher = createGeometryBatcher((batch) => {
          packetsInFlight.push({
            raw: JSON.parse(JSON.stringify(batch)),
            order: nextOrder++,
          })
          return true
        })

        // Track publishers per generation to maintain local monotonic seq
        const publishers: Record<
          number,
          {
            publishPlacement: (p: Placement) => boolean
            publishSize: (s: { axis: 'block' | 'inline'; extent: number }) => boolean
          }
        > = {}
        const genSeqCounters: Record<number, { placement: number; size: number }> = {}

        const getPublishers = (gen: number) => {
          if (!publishers[gen]) {
            genSeqCounters[gen] = { placement: 0, size: 0 }
            publishers[gen] = {
              publishPlacement: createPlacementMessagePublisher(
                { anchorId, generation: gen },
                batcher.publish,
              ),
              publishSize: createSizeMessagePublisher(
                { anchorId, generation: gen },
                batcher.publish,
              ),
            }
          }
          return publishers[gen]!
        }

        const generatedStates: Array<{ kind: 'placement' | 'size'; gen: number; seq: number }> = []

        // 2. Generate publishes strictly driven by fast-check inputs
        for (let i = 0; i < ops.length; i++) {
          const op = ops[i]!
          const pubs = getPublishers(op.generation)
          if (op.kind === 'placement') {
            const seq = ++genSeqCounters[op.generation]!.placement
            pubs.publishPlacement({ visible: true, bounds: { x: 1, y: 1, width: 10, height: 10 } })
            generatedStates.push({ kind: op.kind, gen: op.generation, seq })
          } else {
            const seq = ++genSeqCounters[op.generation]!.size
            pubs.publishSize({ axis: 'block', extent: 20 })
            generatedStates.push({ kind: op.kind, gen: op.generation, seq })
          }

          if (op.flushImmediately) {
            batcher.flush()
          }
        }
        batcher.flush()

        // 3. Apply channel chaos (drops, duplicates, reordering) deterministically using op metadata
        const channelPackets: Array<{ raw: unknown; sortWeight: number }> = []
        for (let i = 0; i < packetsInFlight.length; i++) {
          const item = packetsInFlight[i]!
          const op = ops[i % ops.length]!

          if (op.drop) continue // packet dropped

          channelPackets.push({ raw: item.raw, sortWeight: op.reorderWeight })
          if (op.duplicate) {
            channelPackets.push({ raw: item.raw, sortWeight: op.reorderWeight + 1 })
          }
        }

        // Deterministic shuffle driven by fast-check weights
        channelPackets.sort((a, b) => a.sortWeight - b.sortWeight)

        // 4. Receiver setup with SequenceGuard
        const guard = createGeometrySequenceGuard()
        const appliedGeometry = {
          placement: { gen: -1, seq: -1 },
          size: { gen: -1, seq: -1 },
        }

        // 5. Deliver packets through the decoder and guard
        for (const packet of channelPackets) {
          const decoded = decodeGeometryWireValue(packet.raw, { maxMessages: 50 })
          if (!decoded.ok) continue

          const messages = decoded.value.kind === 'batch' ? decoded.value.messages : [decoded.value]

          for (const msg of messages) {
            const accepted = guard.accept(msg)
            if (accepted) {
              const kind = msg.kind
              const prev = appliedGeometry[kind]

              // ASSERT TLA+ Invariant: ReceiverMonotonicity
              // The applied state at the receiver NEVER goes backwards in generation or sequence!
              const monotonic =
                msg.generation > prev.gen || (msg.generation === prev.gen && msg.seq >= prev.seq)

              expect(monotonic).toBe(true)

              // Update applied geometry
              appliedGeometry[kind] = { gen: msg.generation, seq: msg.seq }

              // ASSERT TLA+ Invariant: Soundness
              // The message must correspond to an actual produced generation and sequence
              expect(
                generatedStates.some(
                  (s) => s.kind === kind && s.gen === msg.generation && s.seq === msg.seq,
                ),
              ).toBe(true)
            }
          }
        }
      }),
      { numRuns: 100 },
    )
  })
})
