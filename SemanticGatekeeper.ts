/**
 * @file app-backend/services/memory/SemanticGatekeeper.ts
 * @description Módulo responsável pelo roteamento semântico de intenções para o Dual-Core.
 */

export enum InteractionIntent {
    COMMAND = "COMMAND",
    FAST_CHAT = "FAST_CHAT",
    DEEP_DIVE = "DEEP_DIVE"
}

export interface GatekeeperContext {
    userQuery: string;
    hasActiveScraperData: boolean;
    historyLength: number;
}

export class SemanticGatekeeper {
    /**
     * Avalia a intenção baseada na heurística local para evitar round-trips à IA só para roteamento.
     */
    static evaluate(ctx: GatekeeperContext): InteractionIntent {
        const commandRegex = /^(crie|adicione|edite|apague|gere um plano|faça um post)/i;
        const deepDiveRegex = /(explique detalhadamente|por que|análise|arquitetura|como funciona|profundamente)/i;

        if (commandRegex.test(ctx.userQuery)) return InteractionIntent.COMMAND;

        // Se a pergunta for longa OU tiver palavras-chave de profundidade OU a tela (DOM) for muito densa
        if (deepDiveRegex.test(ctx.userQuery) || ctx.userQuery.split(' ').length > 15 || ctx.hasActiveScraperData) {
            return InteractionIntent.DEEP_DIVE;
        }

        return InteractionIntent.FAST_CHAT;
    }
}
