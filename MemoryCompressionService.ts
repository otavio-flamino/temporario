/**
 * @file app-backend/services/memory/MemoryCompressionService.ts
 * @description Serviço de compressão de memória do Cognitive OS
 * 
 * Usa modelo local (8B/32B) para comprimir conversas em formato HTF:
 * - CORE: Sempre incluído (info do usuário, projeto)
 * - ACTIVE: Sessão atual (últimas mensagens)
 * - RECALLED: Recuperado por relevância
 * - ARCHIVE: Comprimido/arquivado
 */

import {
    MemoryBlock,
    MemoryCluster,
    CoreContext,
    MemoryBlockType,
    CompressionLevel,
    MemoryCompressionConfig,
    ChatMessage
} from '@contracts';

/**
 * Formato de saída do compressor
 */
interface CompressionOutput {
    facts: string[];      // [FACT] chave = valor
    preferences: string[]; // [PREF] chave = valor
    decisions: string[];   // [DEC] descrição
    summary: string;       // [SUM] resumo curto
    topic: string;         // Tópico principal
    tokens: number;        // Tokens usados
}

/**
 * Configuração padrão de compressão
 */
const DEFAULT_CONFIG: MemoryCompressionConfig = {
    tokenThreshold: 50,           // Iniciar compressão a 50%
    messageThreshold: 15,         // Comprimir após 15 msgs
    topicChangeScore: 0.6,        // Score de mudança de tópico
    rawMessagesCount: 5,          // Últimas 5 msgs intactas
    summaryMessagesRange: [6, 15], // Msgs 6-15 resumidas
    compressionModel: 'llama-8b',
    compressionPersonaId: 'MEMORY_COMPRESSOR'
};

/**
 * Prompt do compressor de memória
 */
const COMPRESSION_PROMPT = `Você é um sistema de compressão de memória do Cognitive OS.

TAREFA: Analise a conversa e extraia informações essenciais de forma EXTREMAMENTE concisa.

FORMATO DE SAÍDA (use exatamente este formato):
[FACT] chave = valor
[PREF] chave = valor  
[DEC] descrição curta
[SUM] resumo em uma linha
[TOPIC] tópico principal

REGRAS:
- Seja EXTREMAMENTE conciso
- Cada linha deve ter no máximo 60 caracteres
- Máximo 10 linhas no total
- Preserve APENAS informações críticas
- NÃO repita informações óbvias

CONVERSA A COMPRIMIR:
{{messages}}`;

/**
 * Serviço de compressão de memória
 */
export class MemoryCompressionService {
    private config: MemoryCompressionConfig;

    constructor(config?: Partial<MemoryCompressionConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Verifica se uma sessão precisa de compressão
     */
    shouldCompress(tokenCount: number, tokenLimit: number, messageCount: number): boolean {
        const tokenPercentage = (tokenCount / tokenLimit) * 100;
        return tokenPercentage >= this.config.tokenThreshold ||
            messageCount >= this.config.messageThreshold;
    }

    /**
     * Comprime mensagens em formato HTF
     */
    async compressMessages(
        messages: ChatMessage[],
        executeAI: (prompt: string) => Promise<string>
    ): Promise<CompressionOutput> {
        // Formatar mensagens para o prompt
        const formattedMessages = messages.map(m =>
            `[${m.role === 'user' ? 'USER' : 'AI'}]: ${m.content.substring(0, 500)}`
        ).join('\n');

        const prompt = COMPRESSION_PROMPT.replace('{{messages}}', formattedMessages);

        // Executar IA de compressão
        const output = await executeAI(prompt);

        // Parse do output
        return this.parseCompressionOutput(output);
    }

    /**
     * Parse do output do compressor
     */
    private parseCompressionOutput(output: string): CompressionOutput {
        const lines = output.split('\n').filter(l => l.trim());

        const result: CompressionOutput = {
            facts: [],
            preferences: [],
            decisions: [],
            summary: '',
            topic: '',
            tokens: 0
        };

        for (const line of lines) {
            if (line.startsWith('[FACT]')) {
                result.facts.push(line.replace('[FACT]', '').trim());
            } else if (line.startsWith('[PREF]')) {
                result.preferences.push(line.replace('[PREF]', '').trim());
            } else if (line.startsWith('[DEC]')) {
                result.decisions.push(line.replace('[DEC]', '').trim());
            } else if (line.startsWith('[SUM]')) {
                result.summary = line.replace('[SUM]', '').trim();
            } else if (line.startsWith('[TOPIC]')) {
                result.topic = line.replace('[TOPIC]', '').trim();
            }
        }

        // Estimar tokens (aproximação: 4 chars = 1 token)
        const totalContent = [...result.facts, ...result.preferences,
        ...result.decisions, result.summary, result.topic].join(' ');
        result.tokens = Math.ceil(totalContent.length / 4);

        return result;
    }

    /**
     * Converte output de compressão para bloco de memória
     */
    createBlockFromCompression(
        userId: string,
        sessionId: string,
        compression: CompressionOutput,
        sourceMessageIds: string[]
    ): Omit<MemoryBlock, 'id' | 'createdAt' | 'updatedAt'> {
        // Formato HTF
        const content = this.formatHTF(compression);

        return {
            userId,
            sessionId,
            type: 'recalled' as MemoryBlockType,
            compressionLevel: 'facts' as CompressionLevel,
            content,
            tokens: compression.tokens,
            topic: compression.topic,
            tags: this.extractTags(compression),
            sourceMessageIds,
            confidence: 1.0,
            decayRate: 0.1,
            accessCount: 0
        };
    }

    /**
     * Formata compressão no formato HTF (Hybrid Tiered Format)
     */
    private formatHTF(compression: CompressionOutput): string {
        const lines: string[] = [];

        if (compression.topic) {
            lines.push(`TOPIC: ${compression.topic}`);
        }

        if (compression.summary) {
            lines.push(`SUM: ${compression.summary}`);
        }

        if (compression.facts.length > 0) {
            lines.push('--- FATOS ---');
            compression.facts.forEach(f => lines.push(`• ${f}`));
        }

        if (compression.preferences.length > 0) {
            lines.push('--- PREFS ---');
            compression.preferences.forEach(p => lines.push(`• ${p}`));
        }

        if (compression.decisions.length > 0) {
            lines.push('--- DECISÕES ---');
            compression.decisions.forEach(d => lines.push(`• ${d}`));
        }

        return lines.join('\n');
    }

    /**
     * Extrai tags do output de compressão
     */
    private extractTags(compression: CompressionOutput): string[] {
        const tags: string[] = [];

        if (compression.topic) {
            tags.push(compression.topic.toLowerCase().replace(/\s+/g, '-'));
        }

        // Extrair keywords do summary
        const keywords = compression.summary
            .toLowerCase()
            .split(/\s+/)
            .filter(w => w.length > 4)
            .slice(0, 3);

        tags.push(...keywords);

        return [...new Set(tags)];
    }

    /**
     * Cria CoreContext inicial para um usuário
     */
    createInitialCoreContext(
        userId: string,
        userName: string,
        language: string = 'pt-br'
    ): Omit<CoreContext, 'id' | 'createdAt' | 'updatedAt'> {
        return {
            userId,
            appName: 'Cognitive OS',
            userName,
            language,
            responseStyle: 'conciso',
            includeCodeExamples: true,
            permanentInstructions: [
                'Sempre responda em português brasileiro (PT-BR)',
                'Seja direto e conciso em suas respostas'
            ],
            userFacts: [],
            tokens: 100 // Estimativa inicial do core
        };
    }

    /**
     * Formata CoreContext para inclusão no prompt
     */
    formatCoreForPrompt(core: CoreContext): string {
        const lines: string[] = [
            '=== CORE (Cognitive OS) ===',
            `USER: ${core.userName} | ${core.userRole || 'user'} | ${core.language}`,
        ];

        if (core.currentProject) {
            lines.push(`PROJECT: ${core.currentProject}`);
        }

        if (core.permanentInstructions.length > 0) {
            lines.push(`INSTRUÇÕES: ${core.permanentInstructions.join('; ')}`);
        }

        if (core.userFacts.length > 0) {
            lines.push(`FATOS: ${core.userFacts.join('; ')}`);
        }

        return lines.join('\n');
    }

    /**
     * Calcula nível de compressão baseado na idade da mensagem
     */
    getCompressionLevelForMessage(
        messageIndex: number,
        totalMessages: number
    ): CompressionLevel {
        const { rawMessagesCount, summaryMessagesRange } = this.config;
        const reversedIndex = totalMessages - messageIndex; // Índice do fim

        if (reversedIndex <= rawMessagesCount) {
            return 'raw';
        } else if (reversedIndex <= summaryMessagesRange[1]) {
            return 'summary';
        } else {
            return 'facts';
        }
    }
}

export default MemoryCompressionService;
