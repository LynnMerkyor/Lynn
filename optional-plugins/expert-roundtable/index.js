import path from 'node:path';

export default class ExpertRoundtablePlugin {
  onload() {
    this.register(this.ctx.engine.registerExpertPresets(this.ctx.pluginId, path.join(this.ctx.pluginDir, 'presets')));
  }
}
