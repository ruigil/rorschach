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
  test('renders nested object schemas and holds reactive values', async () => {
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

    mockStore('currentUserId', 'anonymous')
    mockStore('currentUserRoles', ['admin'])

    const el = await mountClass(RConfigForm) as any
    await el.updateComplete

    await new Promise(r => setTimeout(r, 50))
    await el.updateComplete

    // The nested object label is rendered in light DOM
    const label = el.querySelector('.nested-object-label')
    expect(label).toBeTruthy()
    expect(label.textContent).toBe('agent')

    // The nested fields container is rendered
    const fieldsContainer = el.querySelector('.nested-object-fields')
    expect(fieldsContainer).toBeTruthy()

    // The reactive value model holds the fetched values
    expect(el.currentValues).toEqual({
      notebook: {
        notebookDir: 'my-custom-notebook',
        agent: {
          model: 'google/gemini-3.5-flash',
          maxToolLoops: 20
        }
      }
    })
  })

  test('renders tool-filter (oneOf) schemas with reactive values', async () => {
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

    // The tool-filter container is rendered in light DOM
    const container = el.querySelector('.tool-filter-container')
    expect(container).toBeTruthy()

    // The reactive value model holds the fetched values
    expect(el.currentValues).toEqual({
      workflows: {
        agent: {
          model: 'z-ai/glm-5.1',
          toolFilter: {
            allow: ['switch_mode', 'run_workflow']
          }
        }
      }
    })

    // Simulate a config-field-change event for the toolFilter key
    // (as if the user edited the input)
    el.dispatchEvent(new CustomEvent('config-field-change', {
      bubbles: true,
      composed: true,
      detail: {
        sectionId: 'workflows.agent',
        configKey: 'agent',
        key: 'toolFilter',
        value: { deny: ['delete_file', 'format_disk'] }
      }
    }))
    await el.updateComplete

    expect(el.currentValues.workflows.agent.toolFilter).toEqual({
      deny: ['delete_file', 'format_disk']
    })
  })
})
