import test from 'node:test';
import assert from 'node:assert/strict';
import { translateRequest } from '../src/translate.js';
import { translateChat } from '../src/chat.js';
import { description } from './helpers/fake-wire.js';

for (const [api, translate, input] of [
  ['Responses', translateRequest, { input: 'hello' }],
  ['Chat', translateChat, { messages: [{ role: 'user', content: 'hello' }] }],
]) {
  test(`${api} shares JSON defaults, nullable controls and sampling bounds`, () => {
    const base = { model: description.model, ...input };
    const defaults = translate({ ...base, stream: null, temperature: null, top_p: null, store: null, parallel_tool_calls: null }, description);
    assert.equal(defaults.streaming, false);assert.equal(defaults.request.temperature, undefined);
    assert.equal(defaults.request.top_p, undefined);
    const edge = translate({ ...base, temperature: 2, top_p: 1, parallel_tool_calls: false }, description);
    assert.equal(edge.request.temperature, 2);assert.equal(edge.request.top_p, 1);
    for (const override of [{ temperature: 2.01 }, { temperature: -0.1 }, { top_p: 0 }, { top_p: 1.1 }, { parallel_tool_calls: 'false' }, { stream: 1 }]) {
      assert.throws(() => translate({ ...base, ...override }, description));
    }
  });
}
