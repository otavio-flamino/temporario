import { container, ServiceTokens } from '../../../core/protocols/ServiceContainer';
import { SecureLogger as log } from '../../utils/SecureLogger';
import { CerebrasProvider } from '../ai/providers/CerebrasProvider';
import { ChatTurn } from './HotMemoryService';

/**
 * @class CerebrasSynthesizer
 * @description Fase 2: O Cérebro Sintetizador.
 * Processador hiper-rápido de contexto que extrai fatos e atualiza a memória de trabalho.
 */
export class CerebrasSynthesizer {
    
    /**
     * Sintetiza um lote de turnos evictados (removidos da janela) e os integra ao Live Summary atual.
     */
    public async synthesizeEvictedTurns(evictedTurns: ChatTurn[], currentSummary: string): Promise<{summary: string, keywords: string[]}> {
        if (!evictedTurns || evictedTurns.length === 0) return { summary: currentSummary, keywords: [] };

        const combinedContent = evictedTurns.map(t => `[${t.role.toUpperCase()}]: ${t.content}`).join('\n');

        // Se a mensagem for muito curta e sem contexto, ignoramos a síntese para poupar tokens/rate limits
        if (combinedContent.length < 5) return { summary: currentSummary, keywords: [] };

        try {
            const aiService = await container.resolve<any>(ServiceTokens.AI_SERVICE);
            if (!aiService) {
                log.warn('[CerebrasSynthesizer] AI Service indisponível.');
                return { summary: currentSummary, keywords: [] };
            }

            const prompt = `
[SYSTEM_INSTRUCTION]
Você é o Sintetizador de Memória de uma IA (Luna).
Sua tarefa é ler o "Resumo Vivo Atual" e as "Novas Mensagens", e então extrair fatos importantes, intenções e preferências do usuário.

ATENÇÃO: As "Novas Mensagens" são transcrições de áudio ao vivo e podem conter erros, fragmentos repetidos (ex: "já já to to") ou falhas de reconhecimento. Você DEVE reconstruir mentalmente o sentido real da frase antes de extrair os fatos, ignorando ruídos e erros de digitação/transcrição.
Você DEVE retornar um objeto JSON estrito com o seguinte formato:
{
  "summary": "O resumo vivo atualizado e compacto em bullet points",
  "keywords": ["palavra-chave1", "palavra-chave2", "topico_principal"]
}
Retorne APENAS o JSON válido.

[Resumo Vivo Atual]:
${currentSummary || "Nenhum resumo."}

[Novas Mensagens a Integrar]:
${combinedContent}
`;

            let responseText = '';

            const settingsService = await container.resolve<any>(ServiceTokens.SETTINGS_SERVICE);
            const cerebrasConfig = settingsService ? await settingsService.getApiConfig('cerebras') : null;
            const cerebrasKey = cerebrasConfig?.apiKey;

            if (cerebrasKey && cerebrasKey.trim() !== '') {
                log.info('[CerebrasSynthesizer] Usando provedor Cerebras nativo com limite 30K TPM / 5 RPM.');
                const provider = new CerebrasProvider(cerebrasKey);
                // Utilizando um limite de 1024 tokens de resposta para ficar bem abaixo de 30k TPM
                responseText = await provider.generate(prompt, 'gpt-oss-120b', undefined, { temperature: 0.2, maxTokens: 1024 });
            } else {
                log.info('[CerebrasSynthesizer] Chave da Cerebras ausente. Fazendo fallback para AI Service global.');
                // Utiliza o serviço de IA global do sistema
                responseText = await aiService.generateResponse(
                    'SYSTEM', 
                    'memory-synthesis-session', 
                    prompt,
                    undefined,
                    'pt-BR'
                );
            }

            // Tenta fazer o parse do JSON (limpando crases de markdown se houver)
            responseText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(responseText);

            log.info(`[CerebrasSynthesizer] Síntese concluída. Keywords extraídas: ${parsed.keywords?.join(', ')}`);
            return parsed;

        } catch (error: any) {
            log.error(`[CerebrasSynthesizer] Falha ao sintetizar: ${error.message}`);
            return { summary: currentSummary, keywords: [] };
        }
    }
}

export const cerebrasSynthesizer = new CerebrasSynthesizer();
