/**
 * @file app-backend/services/memory/MemoryDecayService.ts
 * @description Serviço de Decay Temporal para o Cognitive OS
 * 
 * Implementa:
 * - Decay automático de memórias não reforçadas
 * - Arquivamento de memórias com baixa confiança
 * - Reinforcement quando memórias são acessadas
 * - Processamento periódico (background job)
 */

import { SQLiteMemoryBlockRepository } from '../../../database/repositories/SQLiteMemoryBlockRepository';
import type { MemoryBlock } from '../../../core/contracts';

export interface DecayConfig {
    // Decay padrão por dia (1% = 0.01)
    defaultDecayRate: number;
    // Threshold para arquivamento (quando confidence cair abaixo)
    archivalThreshold: number;
    // Dias sem acesso para aplicar decay extra
    stalenessDays: number;
    // Boost de confidence quando reforçado
    reinforcementBoost: number;
}

const DEFAULT_DECAY_CONFIG: DecayConfig = {
    defaultDecayRate: 0.01,      // 1% por dia
    archivalThreshold: 0.15,    // Arquivar quando < 15%
    stalenessDays: 7,           // Aplicar decay extra após 7 dias sem acesso
    reinforcementBoost: 0.1     // +10% quando reforçado
};

export interface DecayReport {
    userId: string;
    processedAt: string;
    blocksDecayed: number;
    blocksArchived: number;
    blocksReinforced: number;
    averageConfidenceAfter: number;
}

export class MemoryDecayService {
    private config: DecayConfig;
    private repository: SQLiteMemoryBlockRepository;

    constructor(config: Partial<DecayConfig> = {}) {
        this.config = { ...DEFAULT_DECAY_CONFIG, ...config };
        this.repository = new SQLiteMemoryBlockRepository();
    }

    /**
     * Processa decay para um usuário
     * Deve ser chamado periodicamente (1x por dia idealmente)
     */
    async processDecay(userId: string): Promise<DecayReport> {
        const processedAt = new Date().toISOString();
        let blocksDecayed = 0;
        let blocksArchived = 0;
        let blocksReinforced = 0;

        try {
            // 1. Aplicar decay a todos os blocos não-core
            blocksDecayed = await this.repository.applyDecayToBlocks(userId, 1);

            // 2. Verificar blocos para arquivamento
            const toArchive = await this.repository.getBlocksForArchival(
                userId,
                this.config.archivalThreshold
            );

            for (const block of toArchive) {
                await this.repository.archiveBlock(block.id);
                blocksArchived++;
            }

            // 3. Calcular média de confiança após processamento
            const allBlocks = await this.repository.getBlocksByUser(userId);
            const avgConf = allBlocks.length > 0
                ? allBlocks.reduce((sum, b) => sum + (b.confidence || 0.5), 0) / allBlocks.length
                : 0;

            console.log(`[MemoryDecay] Processed user ${userId}: decayed=${blocksDecayed}, archived=${blocksArchived}`);

            return {
                userId,
                processedAt,
                blocksDecayed,
                blocksArchived,
                blocksReinforced,
                averageConfidenceAfter: avgConf
            };
        } catch (error) {
            console.error('[MemoryDecay] Error processing decay:', error);
            throw error;
        }
    }

    /**
     * Reforça uma memória quando é acessada/usada
     * Aumenta confidence e reseta contador de decay
     */
    async reinforceBlock(blockId: string): Promise<MemoryBlock | null> {
        return await this.repository.reinforceBlock(blockId);
    }

    /**
     * Reforça múltiplos blocos de uma vez
     * Útil quando contexto é montado e blocos são usados
     */
    async reinforceBlocks(blockIds: string[]): Promise<number> {
        let reinforced = 0;
        for (const id of blockIds) {
            const result = await this.reinforceBlock(id);
            if (result) reinforced++;
        }
        return reinforced;
    }

    /**
     * Obtém estatísticas de saúde da memória
     */
    async getMemoryHealth(userId: string): Promise<{
        totalBlocks: number;
        byType: Record<string, number>;
        byConfidenceRange: {
            high: number;    // > 0.7
            medium: number;  // 0.4 - 0.7
            low: number;     // < 0.4
        };
        avgConfidence: number;
        oldestActive: string | null;
        newestActive: string | null;
    }> {
        const blocks = await this.repository.getBlocksByUser(userId);

        const byType: Record<string, number> = {};
        let sumConfidence = 0;
        let high = 0, medium = 0, low = 0;

        for (const block of blocks) {
            byType[block.type] = (byType[block.type] || 0) + 1;
            sumConfidence += block.confidence || 0.5;

            const conf = block.confidence || 0.5;
            if (conf > 0.7) high++;
            else if (conf >= 0.4) medium++;
            else low++;
        }

        const activeBlocks = blocks.filter(b => b.type !== 'archive')
            .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

        return {
            totalBlocks: blocks.length,
            byType,
            byConfidenceRange: { high, medium, low },
            avgConfidence: blocks.length > 0 ? sumConfidence / blocks.length : 0,
            oldestActive: activeBlocks[0]?.createdAt || null,
            newestActive: activeBlocks[activeBlocks.length - 1]?.createdAt || null
        };
    }

    /**
     * Força arquivamento de blocos muito antigos
     * Útil para limpeza manual
     */
    async forceArchiveOldBlocks(userId: string, daysOld: number): Promise<number> {
        const blocks = await this.repository.getBlocksByUser(userId);
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysOld);

        let archived = 0;
        for (const block of blocks) {
            if (block.type !== 'archive' && block.type !== 'core') {
                const blockDate = new Date(block.createdAt);
                if (blockDate < cutoffDate) {
                    await this.repository.archiveBlock(block.id);
                    archived++;
                }
            }
        }
        return archived;
    }
}
