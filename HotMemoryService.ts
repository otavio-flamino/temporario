import { SecureLogger as log } from '../../utils/SecureLogger';
import { cerebrasSynthesizer } from './CerebrasSynthesizer';
import { workingMemoryManager } from './WorkingMemoryManager';

export interface ChatTurn {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    modality?: 'voice' | 'text';
}

export interface HotMemoryState {
    recentTurns: ChatTurn[];
    liveSummary: string;
}

/**
 * @class HotMemoryService
 * @description Fase 1: Fundação do Contexto.
 * Gerencia a janela deslizante de atenção imediata (HOT Memory) da sessão atual.
 */
export class HotMemoryService {
    private turns: ChatTurn[] = [];
    private liveSummary: string = "";
    
    // Buffer para acúmulo de turnos antes de sintetizar (Rate Limit Protection)
    private pendingSynthesisBuffer: ChatTurn[] = [];
    private synthesisDebounceTimer: NodeJS.Timeout | null = null;
    
    // Configurações da janela deslizante e Rate Limit
    private readonly MAX_TURNS = 10;
    private readonly SYNTHESIS_INTERVAL_MS = 30000; // 30 segundos
    
    // Shadow Memory (Context Handoff) para payloads MCP
    private shadowContexts: { tool: string; timestamp: string; data: any }[] = [];

    constructor() {}

    /**
     * Injeta silenciosamente o resultado de uma tool MCP na memória
     */
    public injectToolPayload(toolName: string, cleanJson: any): void {
        this.shadowContexts.push({
            tool: toolName,
            timestamp: new Date().toISOString(),
            data: cleanJson
        });
        
        // Mantém apenas os últimos 5 payloads para não estourar a RAM
        if (this.shadowContexts.length > 5) {
            this.shadowContexts.shift();
        }
        log.info(`[HotMemoryService] Shadow Context injetado para tool: ${toolName}`);
    }

    /**
     * Adiciona um novo turno à memória quente (preservando tag de modalidade 'voice' | 'text')
     */
    public async addTurn(role: 'user' | 'assistant' | 'system', content: string, modality: 'voice' | 'text' = 'text'): Promise<void> {
        if (!content || content.trim() === '') return;

        this.turns.push({
            role,
            content,
            timestamp: Date.now(),
            modality
        });

        log.info(`[HotMemoryService] Novo turno adicionado. Total na janela: ${this.turns.length}/${this.MAX_TURNS}`);

        // Janela deslizante (Rolling Window)
        if (this.turns.length > this.MAX_TURNS) {
            const evicted = this.turns.shift();
            if (evicted) {
                log.info(`[HotMemoryService] Turno removido da janela (Role: ${evicted.role}). Adicionado ao buffer de síntese.`);
                this.pendingSynthesisBuffer.push(evicted);
                this.scheduleSynthesis();
            }
        }
    }

    /**
     * Agenda a síntese em lote para proteger contra Rate Limits (ex: 5 RPM no Cerebras)
     */
    private scheduleSynthesis(): void {
        if (this.synthesisDebounceTimer) return; // Já está agendado

        log.info(`[HotMemoryService] Agendando síntese em lote para daqui a ${this.SYNTHESIS_INTERVAL_MS / 1000}s...`);
        this.synthesisDebounceTimer = setTimeout(() => {
            this.synthesisDebounceTimer = null;
            this.executeBatchSynthesis();
        }, this.SYNTHESIS_INTERVAL_MS);
    }

    /**
     * Executa a síntese de todo o buffer acumulado
     */
    private executeBatchSynthesis(): void {
        if (this.pendingSynthesisBuffer.length === 0) return;

        // Copia o buffer e limpa o original para não travar novas mensagens
        const turnsToSynthesize = [...this.pendingSynthesisBuffer];
        this.pendingSynthesisBuffer = [];

        log.info(`[HotMemoryService] Executando síntese em lote com ${turnsToSynthesize.length} turnos acumulados...`);
        
        cerebrasSynthesizer.synthesizeEvictedTurns(turnsToSynthesize, this.liveSummary)
            .then(result => {
                this.setLiveSummary(result.summary);
                log.info(`[HotMemoryService] Resumo vivo atualizado via Sintetizador.`);
                
                // Fase 3/4: Passar as keywords para o WorkingMemoryManager atualizar o longo prazo
                if (result.keywords && result.keywords.length > 0) {
                    workingMemoryManager.updateLongTermContext(result.keywords).catch(e => log.error(`RAG Update error: ${e}`));
                }
            })
            .catch(err => {
                log.error(`[HotMemoryService] Erro assíncrono na síntese em lote: ${err}`);
                // Em caso de falha grave, poderíamos devolver ao buffer, mas para evitar loop infinito, ignoramos.
            });
    }

    /**
     * Retorna o estado atual da HOT Memory (Turnos recentes + Resumo Vivo)
     */
    public getState(): HotMemoryState {
        return {
            recentTurns: [...this.turns],
            liveSummary: this.liveSummary
        };
    }
    
    /**
     * Atualiza o resumo vivo da sessão (geralmente injetado pelo CerebrasSynthesizer)
     */
    public setLiveSummary(summary: string): void {
        this.liveSummary = summary;
    }

    /**
     * Retorna a memória formatada em string para injeção rápida no prompt
     */
    public getFormattedString(): string {
        let output = `[LIVE SUMMARY]\n${this.liveSummary || 'Nenhum contexto anterior.'}\n\n`;
        
        if (this.shadowContexts.length > 0) {
            output += `[SHADOW MEMORY CONTEXT]\n`;
            for (const shadow of this.shadowContexts) {
                output += `Tool [${shadow.tool}] (${shadow.timestamp}):\n${JSON.stringify(shadow.data)}\n\n`;
            }
        }
        
        output += `[RECENT TURNS]\n`;
        
        for (const turn of this.turns) {
            const roleName = turn.role === 'user' ? 'USER' : (turn.role === 'assistant' ? 'LUNA' : 'SYSTEM');
            output += `${roleName}: ${turn.content}\n`;
        }
        
        return output;
    }

    /**
     * Limpa a memória quente (usado para zerar o contexto na mudança de sessão)
     */
    public clear(): void {
        this.turns = [];
        this.liveSummary = "";
        this.shadowContexts = [];
        log.info(`[HotMemoryService] HOT Memory limpa.`);
    }
}

// Exportar instância global singleton
export const hotMemoryService = new HotMemoryService();
