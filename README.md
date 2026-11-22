# Natal Osasco · Tarefas

App web (PWA) para repassar e acompanhar as tarefas da decoração de Natal de Osasco por colaborador.

- Gestor entra com senha (variável `GESTOR_SENHA`) e cria tarefas em 4 passos: escolhe um ou vários colaboradores, data e hora da entrega, prioridade (alta, normal, baixa) e título, com anexos (foto, PDF, Word, Excel).
- Colaborador entra digitando o celular e cai direto na própria lista, filtrada primeiro por prioridade.
- Ao abrir a tarefa, o colaborador fica marcado como ciente (o gestor e os colegas da tarefa veem). Cada pessoa aperta Iniciar e Terminar; o app lembra disso o tempo todo.
- Modelos de tarefa: ao criar, marque "Salvar como modelo"; depois é só tocar no modelo e escolher a data.
- Avisos no celular (push): tarefa nova e prazo em menos de 1 hora para o colaborador; "fulano terminou" para o gestor. As chaves ficam guardadas no banco (tabela `config`).
- Para terminar, o colaborador tira uma foto do trabalho pronto (obrigatória).
- O gestor vê em vermelho as tarefas atrasadas e as que vencem em até 2 horas sem ninguém ter iniciado.
- Segurança (aba 🛡 do gestor): seguranças com turno dia/noite e horário. Ao chegar, foto do rosto (nome fica verde); de hora em hora alarme e foto de 3 locais configuráveis; ao sair, foto do rosto (nome fica vermelho). O gestor vê todas as fotos com horário dos últimos 3 dias.
- Tarefas antigas (um responsável, setores, subtarefas) são migradas sozinhas para o novo formato na primeira subida.

Rodar: `DATABASE_URL=... GESTOR_SENHA=... npm start`
