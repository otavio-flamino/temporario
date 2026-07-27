/**
 * @file app-backend/services/memory/MemoryManager.ts
 * @description Orquestrador Único da Memória do Cognitive OS (Luna IA)
 * Conforme definido na arquitetura do diagrama TLDR (memory luna IA.tldr).
 * 
 * Regra Arquitetural Mestra:
 * - Luna IA Voice e Luna IA Chat (Texto) NÃO conversam entre si.
 * - Ambos comunicam-se exclusivamente através do MemoryManager.
 * - O MemoryManager coordena:
 *   1. HOT Memory (Atenção imediata, turnos recentes + resumo vivo da sessão)
 *   2. Working Memory (RAM volátil: objetivo da tarefa, módulo atual, fatos e preferências)
 *   3. Episodic Memory (Histórico de episódios/turnos gravados no SQLite)
 *   4. Semantic Memory (Fatos e conhecimento de longo prazo no SQLite-Vec / RAG DB)
 */

import { hotMemoryService, HotMemoryService } from './HotMemoryService';
import { workingMemoryManager, WorkingMemoryManager } from './WorkingMemoryManager';
import { SecureLogger as log } from '../../utils/SecureLogger';

export interface MemoryTaskState {
    currentGoal?: string;
    currentModule?: string;
    nextAction?: string;
    volatileVariables: Record<string, any>;
    stableFacts: string[];
}

export class MemoryManager {
    private static instance: MemoryManager | null = null;
    
    private hotMemory: HotMemoryService;
    private workingMemory: WorkingMemoryManager;

    private taskState: MemoryTaskState = {
        volatileVariables: {},
        stableFacts: []
    };

    private constructor() {
        this.hotMemory = hotMemoryService;
        this.workingMemory = workingMemoryManager;
        log.info('[MemoryManager] 🧠 Orquestrador Único de Memória inicializado.');
    }

    public static getInstance(): MemoryManager {
        if (!MemoryManager.instance) {
            MemoryManager.instance = new MemoryManager();
        }
        return MemoryManager.instance;
    }

    /**
     * Registra um turno vindo da Luna IA Voice ou do Luna IA Chat (Texto)
     * Desacoplamento: voz e texto gravam pelo mesmo canal orquestrado.
     */
    public async recordTurn(
        source: 'voice' | 'text',
        role: 'user' | 'assistant' | 'system',
        content: string
    ): Promise<void> {
        if (!content || content.trim() === '') return;

        log.info(`[MemoryManager] 📥 Registrando turno [Origem: ${source.toUpperCase()} | Role: ${role}]`);

        // 1. Grava na HOT Memory (com a tag de modalidade)
        await this.hotMemory.addTurn(role, content, source);

        // 2. Tenta extrair fatos estáveis para a Working Memory ou promover para a Semantic Memory
        this.analyzeAndExtractFacts(content, source);
    }

    /**
     * Analisa o conteúdo da mensagem e promove fatos estáveis para a Working / Semantic Memory
     */
    private analyzeAndExtractFacts(content: string, source: 'voice' | 'text'): void {
        // Detecção de declarações de preferências ou tecnologias informadas
        const techMatch = content.match(/(?:estou usando|usando|tecnologia|framework|projeto)\s+([A-Za-z0-9_\-\.]+)/i);
        if (techMatch && techMatch[1]) {
            const fact = `Tecnologia informada via ${source}: ${techMatch[1]}`;
            if (!this.taskState.stableFacts.includes(fact)) {
                this.taskState.stableFacts.push(fact);
                log.info(`[MemoryManager] 💡 Fato estável promovido para Working Memory: "${fact}"`);
            }
        }
    }

    /**
     * Define/atualiza a tarefa ativa na Working Memory
     */
    public updateTaskState(update: Partial<MemoryTaskState>): void {
        this.taskState = {
            ...this.taskState,
            ...update,
            volatileVariables: {
                ...this.taskState.volatileVariables,
                ...(update.volatileVariables || {})
            }
        };
        log.info('[MemoryManager] 🔄 Estado de tarefa na Working Memory atualizado.');
    }

    /**
     * Monta o contexto unificado completo (RAM) para ser injetado no System Prompt
     * Consumido tanto por Luna IA Voice quanto por Luna IA Chat
     */
    public async getUnifiedContextForPrompt(userId?: string): Promise<string> {
        if (userId) {
            await this.workingMemory.preloadContext(userId);
        }

        let ram = this.workingMemory.buildRAM();

        // --- [CORREÇÃO DA AMNÉSIA 2.0] ---
        // Puxando o histórico exato do HotMemoryService usando a função existente
        let hotHistory = '';
        try {
            hotHistory = this.hotMemory.getFormattedString();
        } catch (e) {
            log.warn('[MemoryManager] ⚠️ Falha ao recuperar histórico da Hot Memory', e);
        }

        if (hotHistory && hotHistory.trim() !== '') {
            ram += `\n[MEMÓRIA DE ATENÇÃO IMEDIATA (HOT MEMORY E SHADOW PAYLOADS)]\n${hotHistory}`;
        }
        // ------------------------------

        if (this.taskState.stableFacts.length > 0) {
            ram += `\n[FATOS ESTÁVEIS DA SESSÃO]\n${this.taskState.stableFacts.map(f => `- ${f}`).join('\n')}`;
        }

        if (this.taskState.currentGoal) {
            ram += `\n[OBJETIVO ATUAL DA TAREFA]\n${this.taskState.currentGoal}`;
        }

        return `\n\n[INÍCIO DA MEMÓRIA UNIFICADA LUNA IA - NÃO EXPOR A MENOS QUE SOLICITADO]\n${ram}\n[FIM DA MEMÓRIA UNIFICADA]`;
    }

    /**
     * Obtém o estado volátil da Working Memory
     */
    public getTaskState(): Readonly<MemoryTaskState> {
        return this.taskState;
    }
}

export const memoryManager = MemoryManager.getInstance();