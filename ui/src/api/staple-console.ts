import type { StapleAtlasSource, StapleConsoleBoard } from "@paperclipai/shared/staple-console";
import { api } from "./client";

export const stapleConsoleApi = {
  board: (companyId: string) => api.get<StapleConsoleBoard>(`/companies/${companyId}/staple-console`),
  source: (companyId: string) => api.get<StapleAtlasSource>(`/companies/${companyId}/system-atlas/source`),
};
