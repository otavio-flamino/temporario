/**
 * @file app-backend/services/memory/tokenEstimator.ts
 * @description Estimativa de tokens BPE-aware para modelos LLM
 * 
 * Heurística calibrada para texto em PT-BR e código TypeScript/React.
 * Muito mais precisa que `text.length / 4`, sem dependência externa pesada.
 * 
 * Regras de estimativa baseadas no comportamento real de BPE tokenizers:
 * - Palavras comuns em English: ~1.3 tokens/palavra
 * - Palavras em PT-BR (diacríticos, sufixos): ~1.5-1.8 tokens/palavra
 * - Código TypeScript: ~2.5-3.0 tokens/palavra (muitos símbolos)
 * - JSON/XML: ~2.0 tokens/palavra
 * - Markdown: ~1.5 tokens/palavra (headers, bullets contam extra)
 */

/**
 * Estima tokens de um texto usando heurística BPE-aware
 * Calibrado contra respostas do Gemini e GPT-4
 */
export function estimateTokens(text: string): number {
    if (!text) return 0;

    // 1. Contar palavras reais (split por espaço/newline)
    const words = text.split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;

    // 2. Contar caracteres especiais (cada um geralmente = 1 token)
    const specialChars = (text.match(/[{}()\[\]<>:;,=+\-*/&|!@#$%^~`"'\\]/g) || []).length;

    // 3. Contar números isolados (geralmente 1 token cada)
    const numbers = (text.match(/\b\d+\.?\d*\b/g) || []).length;

    // 4. Contar newlines (cada newline = 1 token)
    const newlines = (text.match(/\n/g) || []).length;

    // 5. Calcular fator de complexidade do conteúdo
    const textLength = text.length;
    const avgWordLength = wordCount > 0 ? textLength / wordCount : 5;

    // Palavras longas (como português/alemão) precisam de mais tokens
    // BPE divide palavras longas em subwords
    let wordTokenMultiplier = 1.0;
    if (avgWordLength > 8) {
        wordTokenMultiplier = 1.5; // Palavras longas = mais subwords
    } else if (avgWordLength > 6) {
        wordTokenMultiplier = 1.3;
    } else if (avgWordLength > 4) {
        wordTokenMultiplier = 1.1;
    }

    // 6. Detectar se é código (muitos símbolos = código)
    const symbolRatio = specialChars / Math.max(textLength, 1);
    if (symbolRatio > 0.15) {
        wordTokenMultiplier *= 1.3; // Código precisa de mais tokens
    }

    // 7. Estimativa final
    const tokenEstimate = Math.ceil(
        (wordCount * wordTokenMultiplier) + // Palavras como tokens
        (specialChars * 0.8) +              // Maioria dos símbolos = 1 token, alguns agrupam
        (numbers * 0.5) +                    // Números parcialmente contados nas palavras
        (newlines * 1.0)                    // Newlines
    );

    // 8. Sanity check: nunca menos que length/6, nunca mais que length/2
    const minEstimate = Math.ceil(textLength / 6);
    const maxEstimate = Math.ceil(textLength / 2);

    return Math.max(minEstimate, Math.min(maxEstimate, tokenEstimate));
}

/**
 * Estima tokens de um array de mensagens de chat
 */
export function estimateMessagesTokens(
    messages: { role: string; content: string }[]
): number {
    let total = 0;
    for (const msg of messages) {
        total += estimateTokens(msg.content);
        total += 4; // Overhead de role/separador (~4 tokens por mensagem)
    }
    return total;
}

/**
 * Calcula quantas mensagens cabem em um budget de tokens (do mais recente ao mais antigo)
 * Retorna o array truncado com as mensagens que cabem
 */
export function truncateMessagesByBudget<T extends { content: string }>(
    messages: T[],
    tokenBudget: number,
    minMessages: number = 2
): { messages: T[]; tokensUsed: number; truncated: boolean } {
    if (messages.length === 0) {
        return { messages: [], tokensUsed: 0, truncated: false };
    }

    let tokensUsed = 0;
    const result: T[] = [];

    // Iterar do mais recente para o mais antigo
    for (let i = messages.length - 1; i >= 0; i--) {
        const msgTokens = estimateTokens(messages[i].content) + 4; // +4 overhead
        if (tokensUsed + msgTokens > tokenBudget && result.length >= minMessages) {
            return { messages: result, tokensUsed, truncated: true };
        }
        result.unshift(messages[i]);
        tokensUsed += msgTokens;
    }

    return { messages: result, tokensUsed, truncated: false };
}
