import * as engine from './engine.mjs';
window.gazeEngine = engine;
parent.gazeLabEngineReady(Number(window.frameElement.dataset.connectionId));
