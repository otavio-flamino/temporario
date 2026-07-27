# Guia de Implementação: Cognitive Memory System

Este guia define os passos práticos para construir o sistema de memória 3-Tier (HOT -> WORKING -> RAG) para a Luna IA, conforme definido no esquema visual (`memory luna IA.tldr`).

## Fase 1: Fundação do Contexto (HOT Memory)
**Objetivo:** Capturar e gerenciar os turnos da sessão atual, gerando um resumo vivo da conversa.
1. Criar o serviço `HotMemoryService.ts`.
2. Implementar a captura de turnos (mensagens do usuário e respostas da Luna).
3. Implementar um sistema de *rolling window* (janela deslizante) que mantém apenas os N últimos turnos brutos.
4. Integrar com o LLM local ou Cerebras para gerar e atualizar um "Live Summary" (resumo vivo) que condensa os turnos mais antigos que caíram da janela.

## Fase 2: O Cérebro Sintetizador (Cerebras API)
**Objetivo:** Integrar a API da Cerebras para atuar como o processador hiper-rápido de contexto.
1. Criar `CerebrasSynthesizer.ts` para conectar à API da Cerebras (usando modelos como Llama 3 8B/70B que rodam a 1000+ tokens/s).
2. Criar os prompts de síntese:
   - **Extração de Fatos:** Identificar "keywords", "preferências do usuário" e "fatos concretos" na HOT Memory.
   - **Cálculo de Importância:** Avaliar a *Relevância + Recência + Importância* de um dado para o contexto atual.

## Fase 3: Conexão RAG (Long Term Memory)
**Objetivo:** Permitir que o Sintetizador puxe contexto profundo para embasar a memória de trabalho.
1. Conectar o `CerebrasSynthesizer` ao `UniversalIndexer.ts` e ao banco SQLite Vetorial.
2. Quando a HOT Memory detecta um novo tópico ou palavra-chave, o Sintetizador faz uma busca no banco vetorial.
3. Permitir que o `mcp_orchestrator` force a gravação de novos aprendizados na RAG DB ("Lembre-se que eu gosto de azul").

## Fase 4: O Coração - Working Memory (Memória RAM)
**Objetivo:** A estrutura final que alimenta a Luna.
1. Criar `WorkingMemoryManager.ts`.
2. Orquestrar as 3 fontes: HOT Memory (turnos curtos) + Fatos Sintetizados + Contexto RAG recuperado.
3. Formatar essa RAM em um bloco de texto enxuto e estruturado (ex: JSON ou Markdown curto).
4. No `LiveAudioService.ts`, injetar a Working Memory atualizada diretamente no `systemInstruction` (ou como primeira mensagem invisível) a cada novo turno, **substituindo** a memória antiga para que o contexto total enviado ao Gemini nunca cresça infinitamente.

## Cronograma de Desenvolvimento
- [ ] Implementar as classes base no diretório `app-backend/services/memory`.
- [ ] Validar a integração com Cerebras API.
- [ ] Testar a injeção da RAM no `LiveAudioService`.
- [ ] Ajustar os parâmetros de decaimento (o que esquecer e quando).
