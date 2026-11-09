import type { StapleConsoleBoard } from "@paperclipai/shared/staple-console";
import { api } from "./client";

export const stapleConsoleApi = {
  board: (companyId: string) => api.get<StapleConsoleBoard>(`/companies/${companyId}/staple-console`),
};
