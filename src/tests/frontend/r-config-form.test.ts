import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mountClass, cleanup, mockStore } from '../helpers/frontend.js'
import { RConfigForm } from '../../frontend/shell/r-config-form.js'

beforeEach(cleanup)
afterEach(cleanup)

const mockSchema = [
  {
    id: 'notebook.config',
    title: 'Notebook',
    subtitle: 'notebook · journal, todos, and tracker',
    tab: 'notebook',
    configKey: '',
    schema: {
      type: 'object',
      properties: {
        notebookDir: { type: 'string', default: 'workspace/notebook', 'x-ui': { label: 'Notebook directory' } },
        agent: {
          type: 'object',
          properties: {
            model: { type: 'string', 'x-ui': { widget: 'model-select', label: 'Agent model' } },
            maxToolLoops: { type: 'number', default: 10, minimum: 1, maximum: 50 },
          },
        },
      },
    },
  }
]

const mockValues = {
  notebookDir: 'my-custom-notebook',
  agent: {
    model: 'google/gemini-3.5-flash',
    maxToolLoops: 20
  }
}

describe('r-config-form', () => {
  test('renders nested object schemas and gathers nested values correctly', async () => {
    // Mock the fetch calls
    globalThis.fetch = (async (url: string | URL) => {
      const urlStr = url.toString()
      if (urlStr.includes('config/schema')) {
        return new Response(JSON.stringify(mockSchema), { headers: { 'Content-Type': 'application/json' } })
      }
      if (urlStr.includes('config/notebook')) {
        return new Response(JSON.stringify(mockValues), { headers: { 'Content-Type': 'application/json' } })
      }
      if (urlStr.includes('models')) {
        return new Response(JSON.stringify(['google/gemini-3.5-flash|Gemini 3.5 Flash', 'deepseek/deepseek-v4-flash|DeepSeek V4 Flash']), { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    // Setup initial store values to enable config schema loading
    mockStore('currentUserId', 'anonymous')
    mockStore('currentUserRoles', ['admin'])

    const el = await mountClass(RConfigForm) as any
    await el.updateComplete

    // Allow loaded schemas and values to resolve and trigger update
    // loadSchemas runs asynchronously after connectedCallback/updated
    await new Promise(r => setTimeout(r, 50))
    await el.updateComplete

    // Check if the nested object label is rendered
    const label = el.querySelector('.nested-object-label')
    expect(label).toBeTruthy()
    expect(label.textContent).toBe('agent')

    // Check if nested fields container is rendered
    const fieldsContainer = el.querySelector('.nested-object-fields')
    expect(fieldsContainer).toBeTruthy()

    // Verify top-level property notebookDir
    const dirInput = el.querySelector('input[name="notebookDir"]') as HTMLInputElement
    expect(dirInput).toBeTruthy()
    expect(dirInput.value).toBe('my-custom-notebook')

    // Verify nested model select hidden input
    const modelInput = el.querySelector('input[name="model"]') as HTMLInputElement
    expect(modelInput).toBeTruthy()
    expect(modelInput.value).toBe('google/gemini-3.5-flash')

    // Verify nested number input
    const maxToolLoopsInput = el.querySelector('input[name="maxToolLoops"]') as HTMLInputElement
    expect(maxToolLoopsInput).toBeTruthy()
    expect(Number(maxToolLoopsInput.value)).toBe(20)

    // Test data gathering
    const gathered = el._gatherValuesByPlugin()
    expect(gathered).toEqual({
      notebook: {
        notebookDir: 'my-custom-notebook',
        agent: {
          model: 'google/gemini-3.5-flash',
          maxToolLoops: 20
        }
      }
    })
  })

  test('renders tool-filter (oneOf) schemas and gathers array values correctly', async () => {
    const mockWorkflowSchema = [
      {
        id: 'workflows.agent',
        title: 'Workflows',
        subtitle: 'workflow model',
        tab: 'workflows',
        configKey: 'agent',
        schema: {
          type: 'object',
          properties: {
            model: { type: 'string', 'x-ui': { widget: 'model-select' } },
            toolFilter: {
              type: 'object',
              oneOf: [
                {
                  type: 'object',
                  required: ['allow'],
                  properties: { allow: { type: 'array', items: { type: 'string' } } }
                },
                {
                  type: 'object',
                  required: ['deny'],
                  properties: { deny: { type: 'array', items: { type: 'string' } } }
                }
              ]
            }
          }
        }
      }
    ]

    const mockWorkflowValues = {
      agent: {
        model: 'z-ai/glm-5.1',
        toolFilter: {
          allow: ['switch_mode', 'run_workflow']
        }
      }
    }

    // Mock fetch for workflows
    globalThis.fetch = (async (url: string | URL) => {
      const urlStr = url.toString()
      if (urlStr.includes('config/schema')) {
        return new Response(JSON.stringify(mockWorkflowSchema), { headers: { 'Content-Type': 'application/json' } })
      }
      if (urlStr.includes('config/workflows')) {
        return new Response(JSON.stringify(mockWorkflowValues), { headers: { 'Content-Type': 'application/json' } })
      }
      if (urlStr.includes('models')) {
        return new Response(JSON.stringify(['z-ai/glm-5.1|GLM 5.1']), { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    mockStore('currentUserId', 'anonymous')
    mockStore('currentUserRoles', ['admin'])

    const el = await mountClass(RConfigForm) as any
    await el.updateComplete

    await new Promise(r => setTimeout(r, 50))
    await el.updateComplete

    // Check if select filter type and array input are rendered
    const container = el.querySelector('.tool-filter-container')
    expect(container).toBeTruthy()

    const select = container.querySelector('select') as HTMLSelectElement
    expect(select).toBeTruthy()
    expect(select.value).toBe('allow')

    const input = container.querySelector('input') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.name).toBe('allow')
    expect(input.value).toBe('switch_mode, run_workflow')

    // Test gathering initial values
    let gathered = el._gatherValuesByPlugin()
    expect(gathered).toEqual({
      workflows: {
        agent: {
          model: 'z-ai/glm-5.1',
          toolFilter: {
            allow: ['switch_mode', 'run_workflow']
          }
        }
      }
    })

    // Test changing filter type to deny
    select.value = 'deny'
    select.dispatchEvent(new Event('change'))
    await el.updateComplete

    // When switched, name changes to 'deny' and value is read from current value or empty
    expect(input.name).toBe('deny')

    // Set input value to a new list of deny tools
    input.value = 'delete_file, format_disk'
    input.dispatchEvent(new Event('input'))

    // Gather values again
    gathered = el._gatherValuesByPlugin()
    expect(gathered).toEqual({
      workflows: {
        agent: {
          model: 'z-ai/glm-5.1',
          toolFilter: {
            deny: ['delete_file', 'format_disk']
          }
        }
      }
    })
  })
})

