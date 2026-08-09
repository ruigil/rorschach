import type { SCRDescriptor } from '../../types/scr.ts'

export type RegistryMsg =
  | { type: '_register'; descriptor: SCRDescriptor }
  | { type: '_deregister'; urn: string }

export type RegistryState = {
  descriptors: Map<string, SCRDescriptor>
}
