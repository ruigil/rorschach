export type PlanTask = {
  id:                 string
  name:               string
  description:        string
  validationCriteria: string
  dependencies:       string[]
}

export type Plan = {
  id:        string
  goal:      string
  context:   string
  createdAt: string
  tasks:     PlanTask[]
}
