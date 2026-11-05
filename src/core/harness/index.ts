export interface HarnessInfo {
  id: string;
  nome: string;
  descricao: string;
  disponivel: boolean;
  versao?: string;
  caminho?: string;
  padrao?: boolean;
  em_breve?: boolean;
}

export interface AgentHarness {
  readonly id: string;
  readonly nome: string;
  readonly descricao: string;

  verificarDisponibilidade(): Promise<{
    disponivel: boolean;
    versao?: string;
    caminho?: string;
    erro?: string;
  }>;
}

export class HarnessRegistry {
  private harnesses = new Map<string, AgentHarness>();
  private harnessPadrao = "claude-sdk";

  registrar(harness: AgentHarness): void {
    this.harnesses.set(harness.id, harness);
  }

  obter(id: string): AgentHarness | undefined {
    return this.harnesses.get(id);
  }

  definirPadrao(id: string): void {
    if (this.harnesses.has(id)) {
      this.harnessPadrao = id;
    }
  }

  obterPadrao(): string {
    return this.harnessPadrao;
  }

  listar(): AgentHarness[] {
    return Array.from(this.harnesses.values());
  }
}

export const harnessRegistry = new HarnessRegistry();
