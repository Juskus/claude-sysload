import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'sysload',
  component: 'Pane',
  requestId: 'sysload',
  props: {
    title: 'PC load',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// Lines as Ollama's llama.cpp runner writes them.
const FINISHED = [
  'slot print_timing: id  0 | task 20332 | n_gen =    200, tg =  65.85 t/s, tg_3s =  66.18 t/s',
  'slot print_timing: id  0 | task 20332 | prompt eval time =     433.16 ms /    51 tokens (    8.49 ms per token,   117.74 tokens per second)',
  'slot print_timing: id  0 | task 20332 |        eval time =    6505.16 ms /   457 tokens (   14.27 ms per token,    70.10 tokens per second)',
  'slot print_timing: id  0 | task 20332 |       total time =    6938.32 ms /   508 tokens',
  'slot print_timing: id  0 | task 20332 | draft acceptance = 0.60000 (  324 accepted /   540 generated), mean len =  3.40',
]
const LIVE = [...FINISHED, 'slot print_timing: id  0 | task 20400 | n_gen =    314, tg =  51.64 t/s, tg_3s =  48.67 t/s']

const host = (llm: unknown, lock: unknown = null) =>
  JSON.stringify({ cpu: 12, ramFreeKb: 32 * 1024 ** 2, ramTotalKb: 64 * 1024 ** 2, drives: [], lock, llm, locale: 'en-US' })

for (const [name, lines, ageS, expected] of [
  ['a finished request shows its speed', FINISHED, 20, /Local model: qwen3\.8-worker · last 70 tok\/s \(457 tok\.\), 20 s ago/],
  ['a request in progress shows the live speed', LIVE, 1, /Local model: qwen3\.8-worker · generating 49 tok\/s/],
] as const) {
  test(name, async ($, on) => {
    on('store.get', () => ({ value: undefined }))
    on('clock.every', () => ({ value: undefined }))
    on('command.register', () => ({ value: { command: 'sysload' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('process.run', (_, e) =>
      e.argv[0] === 'nvidia-smi'
        ? { value: { exitCode: 0, stdout: '86, 22900, 24576, 71, 398\n', stderr: '' } }
        : { value: { exitCode: 0, stdout: host({ ageS, lines, models: 'qwen3.8-worker:latest' }), stderr: '' } },
    )

    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ type: 'Text', text: /Local model/ }))?.text).toMatch(expected)
      expect((await ui.find({ type: 'Text', text: /qwen3\.8-worker$/ }))?.text).toBe('qwen3.8-worker')
      await ui.unmount()
    }
  })
}

test('the GPU lock pid reads as text, also in the old wrapped form', async ($, on) => {
  on('store.get', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'sysload' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) =>
    e.argv[0] === 'nvidia-smi'
      ? { value: { exitCode: 1, stdout: '', stderr: '' } }
      : { value: { exitCode: 0, stdout: host(null, { value: '4242\n', PSPath: 'x' }), stderr: '' } },
  )

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /GPU lock/ }))?.text).toBe('GPU lock: taken (pid 4242)')
  expect(await ui.find({ type: 'Text', text: /Local model/ })).toBeUndefined()
  await ui.unmount()
})
