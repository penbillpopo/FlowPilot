import type { FlowPilotApi } from '../../shared/types';

declare global {
  interface Window {
    flowpilot: FlowPilotApi;
  }
}
