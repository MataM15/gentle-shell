# Voice conversation: hear replies and talk hands-free

Adds spoken replies and a hands-free conversation mode to the existing `/gentle:voice` dictation (Parakeet, `alt+m`), with no external package.
Branch `feat/voice-conversation`, based on the personal branch `feat/aligned-rdd-cards` (it carries the WSLg capture fix).

## Specs

- S1. Speech output: the agent's final reply is read aloud. Agreed design: "Cuando Pi termina una respuesta, la extensión toma el texto final y lo limpia: saca bloques de código, tablas y rutas largas, porque nadie quiere escuchar un diff. Ese texto va a un motor de voz que corre en un proceso aparte, con el mismo patrón que ya usa tu dictado."
- S2. Conversation mode: "Hablás, el texto se envía solo, Pi responde, te lo lee, y el micrófono se vuelve a abrir. Esc o Alt+M cortan en cualquier momento."
- S3. Controls: "Un comando para prender y apagar la voz, silenciar, y cortar una lectura a la mitad."
- S4. No external package: "ahorrándonos también esto de tener que instalar un repositorio externo". Ideas may come from the MIT `gentle-voice` npm package; no code or dependency from it.
- S5. First engine: the Windows voice (Sabina, es-MX) through PowerShell from WSL, no download. "arrancar con Sabina para tener la conversación andando de punta a punta, y sumar Kokoro como segundo motor."
- S6. Second engine: local Kokoro, "Suena mucho más natural, pero baja unos 370 MB", installed and verified with the same care as dictation, downloads only after consent.

## Tasks

- T1 [S1,S5] Speech module: spoken-text cleanup, reply language guess, Windows SAPI engine in its own process, cancellable. Route inline. Commit: pending.
- T2 [S1,S3] Read replies aloud: persisted on/off, `/gentle:voice` menu entries, speak on settle, Esc and the toggle key cut a reading, docs. Route inline. Commit: pending.
- T3 [S2,S3] Conversation mode: silence end-of-speech in the worker, transcript sent instead of pasted, listen again after the reply is read, docs. Route inline. Commit: pending.
- T4 [S6] Kokoro engine with consented, pinned, verified download. Route inline after research. Commit: pending.

## Log

- L1 (user, original request): "https://anoma.ly/hex/ Se puede usar eso para dictar y que me hable el agente de pi/gentle-shell?" Follow-up: "no hay algo creado ya que sea parecido, pero que haga, digamos, ambas funciones que para que yo pueda hablar ... y que me diga también lo que ... el texto de la gente, digamos, para tener esa interacción".
- L2 (user): "se podría hacer algo parecido, pero que quizás funcione mejor. Igual me gusta bastante lo que vi. ... ahorrándonos también esto de tener que instalar un repositorio externo ... quizás podemos hacer algo parecido nosotros acá."
- L3 (user, accepting Sabina first then Kokoro): "ok dale".
- L4 (evidence): PowerShell from WSL selected "Microsoft Sabina Desktop" for es-*, base64 UTF-8 text through stdin kept the accents, and killing the WSL-side process stopped the Windows speech. The user heard it: "Esuche un \"hola soy el gentle man\" puede ser?"
