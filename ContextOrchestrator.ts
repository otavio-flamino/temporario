/**
 * @file app-backend/services/memory/ContextOrchestrator.ts
 * @description Orquestrador de contexto do Cognitive OS
 * 
 * Responsável por:
 * 1. Selecionar blocos de memória relevantes
 * 2. Montar contexto final dentro do budget de tokens
 * 3. Aplicar camada Core (sempre presente)
 * 4. Balancear blocos Active, Recalled e Archive
 */

import {
    MemoryBlock,
    CoreContext,
    MemoryBlockType,
    ChatMessage
} from '@contracts';

/**
 * Configuração do orquestrador
 */
interface OrchestratorConfig {
    tokenBudget: number;          // Budget total (ex: 32000)
    coreReserve: number;          // Reserva para Core (ex: 500)
    activeReserve: number;        // Reserva para Active (ex: 8000)
    rawMessagesCount: number;     // Últimas N msgs sem compressão
}

/**
 * Resultado da montagem de contexto
 */
interface ContextAssemblyResult {
    fullContext: string;          // Contexto pronto para usar
    tokensUsed: number;
    tokensBudget: number;
    blocksIncluded: {
        core: boolean;
        activeCount: number;
        recalledCount: number;
        archiveCount: number;
    };
    compressionApplied: boolean;
}

/**
 * Configuração padrão
 */
const DEFAULT_CONFIG: OrchestratorConfig = {
    tokenBudget: 32000,
    coreReserve: 500,
    activeReserve: 8000,
    rawMessagesCount: 5
};

/**
 * Orquestrador de Contexto
 */
export class ContextOrchestrator {
    private config: OrchestratorConfig;

    constructor(config?: Partial<OrchestratorConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Monta o contexto final para enviar à IA
     */
    async assembleContext(
        coreContext: CoreContext,
        recentMessages: ChatMessage[],
        memoryBlocks: MemoryBlock[],
        queryEmbedding?: number[]
    ): Promise<ContextAssemblyResult> {
        const sections: string[] = [];
        let tokensUsed = 0;

        // 1. SEMPRE incluir Core
        const coreFormatted = this.formatCoreContext(coreContext);
        sections.push(coreFormatted);
        tokensUsed += coreContext.tokens;

        // 2. Incluir mensagens recentes (RAW - sem compressão)
        const rawMessages = recentMessages.slice(-this.config.rawMessagesCount);
        const rawFormatted = this.formatRawMessages(rawMessages);
        const rawTokens = this.estimateTokens(rawFormatted);
        sections.push(rawFormatted);
        tokensUsed += rawTokens;

        // 3. Calcular budget restante para blocos recalled
        const remainingBudget = this.config.tokenBudget - tokensUsed - this.config.coreReserve;

        // 4. Selecionar blocos por relevância
        const selectedBlocks = this.selectBlocksByRelevance(
            memoryBlocks,
            remainingBudget,
            queryEmbedding
        );

        // 5. Adicionar blocos selecionados
        let activeCount = 0;
        let recalledCount = 0;
        let archiveCount = 0;

        for (const block of selectedBlocks.blocks) {
            sections.push(this.formatMemoryBlock(block));
            tokensUsed += block.tokens;

            switch (block.type) {
                case 'active': activeCount++; break;
                case 'recalled': recalledCount++; break;
                case 'archive': archiveCount++; break;
            }
        }

        return {
            fullContext: sections.join('\n\n'),
            tokensUsed,
            tokensBudget: this.config.tokenBudget,
            blocksIncluded: {
                core: true,
                activeCount,
                recalledCount,
                archiveCount
            },
            compressionApplied: archiveCount > 0 || recalledCount > 0
        };
    }

    /**
     * Formata o CoreContext para o prompt
     */
    private formatCoreContext(core: CoreContext): string {
        const lines: string[] = [
            '=== CORE (Cognitive OS) ===',
            `USER: ${core.userName} | ${core.language.toUpperCase()} | ${core.responseStyle}`
        ];

        if (core.currentProject) {
            lines.push(`PROJECT: ${core.currentProject}`);
        }

        if (core.permanentInstructions.length > 0) {
            lines.push(`RULES: ${core.permanentInstructions.slice(0, 3).join(' | ')}`);
        }

        if (core.userFacts.length > 0) {
            lines.push(`FACTS: ${core.userFacts.slice(0, 5).join(' | ')}`);
        }

        return lines.join('\n');
    }

    /**
     * Formata mensagens recentes (sem compressão)
     */
    private formatRawMessages(messages: ChatMessage[]): string {
        if (messages.length === 0) return '';

        const lines: string[] = ['=== ACTIVE (Recent) ==='];

        for (const msg of messages) {
            const role = msg.role === 'user' ? 'USER' : 'AI';
            const content = msg.content.length > 300
                ? msg.content.substring(0, 300) + '...'
                : msg.content;
            lines.push(`[${role}]: ${content}`);
        }

        return lines.join('\n');
    }

    /**
     * Formata um bloco de memória
     */
    private formatMemoryBlock(block: MemoryBlock): string {
        const header = `=== ${block.type.toUpperCase()} [${block.topic || 'context'}] ===`;
        return `${header}\n${block.content}`;
    }

    /**
     * Seleciona blocos por relevância dentro do budget
     */
    private selectBlocksByRelevance(
        blocks: MemoryBlock[],
        tokenBudget: number,
        queryEmbedding?: number[]
    ): { blocks: MemoryBlock[]; tokensUsed: number } {
        // Ordenar blocos por tipo (prioridade) e relevância
        const priorityOrder: Record<MemoryBlockType, number> = {
            'core': 0,    // Core já incluído separadamente
            'active': 1,
            'recalled': 2,
            'archive': 3
        };

        const sortedBlocks = blocks
            .filter(b => b.type !== 'core') // Core já incluído
            .map(block => ({
                block,
                priority: priorityOrder[block.type],
                score: block.relevanceScore || 0.5
            }))
            .sort((a, b) => {
                // Primeiro por prioridade, depois por score
                if (a.priority !== b.priority) {
                    return a.priority - b.priority;
                }
                return b.score - a.score;
            });

        const selectedBlocks: MemoryBlock[] = [];
        let tokensUsed = 0;

        for (const { block } of sortedBlocks) {
            if (tokensUsed + block.tokens <= tokenBudget) {
                selectedBlocks.push(block);
                tokensUsed += block.tokens;
            }
        }

        return { blocks: selectedBlocks, tokensUsed };
    }

    /**
     * Estima tokens de um texto (aproximação: 4 chars = 1 token)
     */
    private estimateTokens(text: string): number {
        return Math.ceil(text.length / 4);
    }

    /**
     * Verifica se precisa comprimir baseado no uso atual de tokens
     */
    needsCompression(currentTokens: number): boolean {
        const threshold = this.config.tokenBudget * 0.5; // 50%
        return currentTokens >= threshold;
    }

    /**
     * Calcula quantos tokens ainda estão disponíveis
     */
    getRemainingTokens(usedTokens: number): number {
        return this.config.tokenBudget - usedTokens;
    }

    /**
     * Retorna métricas de uso para UI
     */
    getUsageMetrics(usedTokens: number): {
        used: number;
        limit: number;
        percentage: number;
        status: 'ok' | 'warning' | 'critical';
    } {
        const percentage = (usedTokens / this.config.tokenBudget) * 100;
        let status: 'ok' | 'warning' | 'critical' = 'ok';

        if (percentage >= 90) status = 'critical';
        else if (percentage >= 70) status = 'warning';

        return {
            used: usedTokens,
            limit: this.config.tokenBudget,
            percentage,
            status
        };
    }
}

export default ContextOrchestrator;
