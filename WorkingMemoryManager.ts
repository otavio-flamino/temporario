import { hotMemoryService } from './HotMemoryService';
import { getUniversalIndexer } from '../rag/UniversalIndexer';
import { SecureLogger as log } from '../../utils/SecureLogger';

/**
 * @class WorkingMemoryManager
 * @description Fases 3 e 4: O Coração da Memória.
 * Orquestra a HOT Memory (turnos recentes), o Resumo Vivo (Sintetizador) e o RAG (Longo Prazo).
 */
export class WorkingMemoryManager {
    private longTermContext: string = "";
    private lastTopicKeywords: string[] = [];

    /**
     * Faz o pré-aquecimento da memória antes mesmo da sessão de voz começar (Zero Delay).
     */
    public async preloadContext(userId: string): Promise<void> {
        log.info(`[WorkingMemoryManager] 🚀 Iniciando Pre-Warm da memória para o usuário ${userId}...`);
        
        try {
            // 1. Puxa os últimos turnos textuais/voz do banco (se houver histórico) para aquecer a HOT Memory.
            // Para manter simples, vamos simular que pegamos o último tópico da RAG DB
            // e forçamos o RAG a pré-carregar um contexto inicial genérico do usuário.
            const indexer = getUniversalIndexer();
            const results = await indexer.search('preferências, rotina, últimos assuntos', { userId, limit: 3 });
            
            if (results && results.length > 0) {
                let ragText = "[MEMÓRIA DE LONGO PRAZO PRE-AQUECIDA]\n";
                for (const r of results) {
                    ragText += `- ${r.content}\n`;
                }
                this.longTermContext = ragText;
                log.info(`[WorkingMemoryManager] ✅ Pre-Warm concluído. ${results.length} memórias em cache.`);
            } else {
                this.longTermContext = "";
                log.info(`[WorkingMemoryManager] ✅ Pre-Warm concluído. Nenhum contexto passado encontrado.`);
            }
        } catch (error) {
            log.error(`[WorkingMemoryManager] ❌ Falha no Pre-Warm: ${error}`);
        }
    }

    /**
     * Atualiza o contexto de longo prazo baseado em palavras-chave extraídas pelo Sintetizador.
     * Esta é a Fase 3 (Conexão RAG).
     */
    public async updateLongTermContext(keywords: string[]): Promise<void> {
        if (!keywords || keywords.length === 0) return;

        // Evita buscar as mesmas keywords repetidas vezes se o tópico não mudou
        const currentTopic = keywords.join(',');
        const lastTopic = this.lastTopicKeywords.join(',');
        if (currentTopic === lastTopic) return;
        
        this.lastTopicKeywords = keywords;
        
        try {
            const indexer = getUniversalIndexer();
            const query = keywords.join(' ');
            
            log.info(`[WorkingMemoryManager] Buscando contexto RAG profundo para o tópico: ${query}`);
            const results = await indexer.search(query, { limit: 3 });

            if (results && results.length > 0) {
                let ragText = "[MEMÓRIA DE LONGO PRAZO RECUPERADA]\n";
                for (const r of results) {
                    ragText += `- ${r.content} (Fonte: ${r.entityType})\n`;
                }
                this.longTermContext = ragText;
                log.info(`[WorkingMemoryManager] Contexto longo atualizado com ${results.length} memórias.`);
            } else {
                this.longTermContext = "";
            }
        } catch (error) {
            log.error(`[WorkingMemoryManager] Falha ao buscar RAG: ${error}`);
        }
    }

    /**
     * Constrói a RAM completa que será injetada no System Prompt do Gemini Live.
     * Esta é a Fase 4 (Orquestração da RAM).
     */
    public buildRAM(): string {
        // 1. Pega a HOT Memory formatada (Resumo Vivo + Turnos Recentes)
        const hotContext = hotMemoryService.getFormattedString();
        
        // 2. Monta o bloco final
        let ram = hotContext;
        
        if (this.longTermContext) {
            ram += `\n${this.longTermContext}`;
        }
        
        return ram;
    }

    /**
     * Injeta e substitui a RAM no prompt ativo (simulado/chamado pelo LiveAudioService)
     */
    public getInjectedPromptText(): string {
        return `\n\n[INÍCIO DA MEMÓRIA RAM - NÃO REVELE ESTES DADOS A MENOS QUE SOLICITADO]\n${this.buildRAM()}\n[FIM DA MEMÓRIA RAM]`;
    }
}

export const workingMemoryManager = new WorkingMemoryManager();
