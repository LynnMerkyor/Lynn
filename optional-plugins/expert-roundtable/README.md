# 专家圆桌（可选插件）

适用于 Lynn 0.87.0 及以上。包含心理、法律、金融、产品、创作与创业六组顾问预设，使用用户自己配置的模型。安装前不会加载到默认界面。

下载并解压本版本的 `lynn-expert-roundtable-0.87.0.zip`，使用 Node.js 20 或以上运行：

```sh
node install.mjs --home /你的/Lynn/数据目录
```

`--home` 必须指向当前 Lynn 数据目录（含 `agents`、配置等），不是工作空间目录；如果已设置 `LYNN_HOME`，可以省略该参数。脚本只复制到该目录下的 `plugins/expert-roundtable`，已有同名目录时拒绝覆盖。重启 Lynn 后，在频道空状态中选择顾问和模型，或创建多顾问圆桌。

卸载：退出 Lynn 后移走 `plugins/expert-roundtable` 目录，再重新启动。已经创建的角色、身份说明、头像、频道及历史留在用户数据目录，不会随插件移除。重新安装可恢复预设入口。

The optional Expert Roundtable plugin uses your configured models. Install with the command above, pointing `--home` to the Lynn data directory, then restart Lynn. Removing this plugin does not delete existing agents or conversations.
