/**
 * @file app-backend/services/memory/MemoryGate.ts
 * @description Filtro inteligente para decidir o que deve ser persistido como memória
 * 
 * Implementa Memory Gate (filtro lógico) que responde:
 * "Essa informação merece virar memória?"
 * 
 * Evita salvar:
 * - Saudações e convenções sociais
 * - Confirmações simples (ok, sim, entendi)
 * - Ruído sem valor informativo
 * 
 * Preserva:
 * - Fatos sobre o usuário
 * - Decisões e preferências
 * - Padrões de comportamento
 * - Conhecimentos e skills
 */

export interface GateDecision {
    shouldPersist: boolean;
    reason: string;
    suggestedType?: 'fact' | 'preference' | 'decision' | 'pattern' | 'skill' | 'goal' | 'correction' | 'summary';
    estimatedConfidence: number;
}

// Padrões de ruído que NÃO devem virar memória
const NOISE_PATTERNS = [
    // Saudações
    /^(oi|olá|ola|hey|hi|hello|e ai|fala|salve)/i,
    /^(bom dia|boa tarde|boa noite)/i,
    /^(tchau|até|ate logo|falou|flw|vlw)/i,

    // Confirmações simples
    /^(ok|okay|sim|não|nao|entendi|certo|beleza|blz|show|massa|top|legal|valeu|vlw|obrigado|obg|thanks|thx)$/i,
    /^(pode ser|tá|ta|tá bom|ta bom|hmm|uhum|aham|ahn)$/i,

    // Respostas curtas sem informação
    /^.{1,5}$/,  // Menos de 5 caracteres

    // Repetições de pontuação
    /^[!?.]+$/,

    // Emojis sozinhos
    /^[\p{Emoji}\s]+$/u
];

// Padrões que DEVEM virar memória
const VALUABLE_PATTERNS = [
    // Preferências
    { pattern: /\b(prefiro|gosto de|não gosto|odeio|adoro|minha preferência)\b/i, type: 'preference' as const, confidence: 0.8 },
    { pattern: /\b(sempre|nunca|costumo|tenho o hábito)\b/i, type: 'pattern' as const, confidence: 0.7 },

    // Fatos pessoais
    { pattern: /\b(meu nome|me chamo|sou o|sou a|trabalho com|minha profissão|minha área)\b/i, type: 'fact' as const, confidence: 0.9 },
    { pattern: /\b(moro em|vivo em|sou de|nasci em)\b/i, type: 'fact' as const, confidence: 0.85 },

    // Skills e conhecimentos
    { pattern: /\b(sei|conheço|domino|tenho experiência|trabalho com|uso)\b.*\b(anos?|tempo)\b/i, type: 'skill' as const, confidence: 0.75 },
    { pattern: /\b(programo em|desenvolvo em|stack|linguagem)\b/i, type: 'skill' as const, confidence: 0.8 },

    // Decisões
    { pattern: /\b(decidi|vou|vamos|escolhi|optei|definido)\b/i, type: 'decision' as const, confidence: 0.85 },

    // Metas
    { pattern: /\b(quero|pretendo|meu objetivo|meta|planejo|vou aprender)\b/i, type: 'goal' as const, confidence: 0.7 },

    // Correções
    { pattern: /\b(na verdade|corrigi|mudei|não é bem|errei|quero mudar)\b/i, type: 'correction' as const, confidence: 0.8 }
];

export class MemoryGate {

    /**
     * Avalia uma mensagem e decide se ela deve ser persistida
     * @param content Mensagem do usuário
     * @returns Decisão com confiança e tipo sugerido
     */
    public evaluate(content: string): GateDecision {
        // A pedido do usuário, 100% das mensagens agora viram embedding (Overridden)
        return {
            shouldPersist: true,
            reason: 'forced_100_percent_by_user',
            suggestedType: 'summary',
            estimatedConfidence: 1.0
        };
    }

    /**
     * Avalia múltiplas mensagens e retorna quais devem ser persistidas
     */
    evaluateBatch(messages: { role: string; content: string }[]): {
        content: string;
        role: string;
        decision: GateDecision;
    }[] {
        return messages
            .map(msg => ({
                ...msg,
                decision: this.evaluate(msg.content)
            }))
            .filter(m => m.decision.shouldPersist);
    }

    /**
     * Calcula score médio de uma conversa
     * Útil para decidir se vale a pena comprimir
     */
    calculateConversationValue(messages: { content: string }[]): {
        averageConfidence: number;
        valuableCount: number;
        noiseCount: number;
        shouldCompress: boolean;
    } {
        let totalConfidence = 0;
        let valuableCount = 0;
        let noiseCount = 0;

        for (const msg of messages) {
            const decision = this.evaluate(msg.content);
            if (decision.shouldPersist) {
                valuableCount++;
                totalConfidence += decision.estimatedConfidence;
            } else {
                noiseCount++;
            }
        }

        const averageConfidence = valuableCount > 0
            ? totalConfidence / valuableCount
            : 0;

        return {
            averageConfidence,
            valuableCount,
            noiseCount,
            // Só comprime se tiver conteúdo valioso suficiente
            shouldCompress: valuableCount >= 3 && averageConfidence >= 0.5
        };
    }
}
