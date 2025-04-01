import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	request,
	moment,
	TFile,
	normalizePath,
	Modal,
} from "obsidian";
import { Summary } from "./model";
import {
	appHasDailyNotesPluginLoaded,
	createDailyNote,
	getAllDailyNotes,
	getDailyNote,
} from "obsidian-daily-notes-interface";

// Remember to rename these classes and interfaces!

interface WakaBoxPluginSettings {
	apiKey: string;
	updateIntervalMinutes: number;
	enableDailyBatchMode: boolean;
	batchUpdateHours: number;
	batchUpdateMinutes: number;
}

const DEFAULT_SETTINGS: WakaBoxPluginSettings = {
	apiKey: "",
	updateIntervalMinutes: 0,
	enableDailyBatchMode: false,
	batchUpdateHours: 0,
	batchUpdateMinutes: 0,
};

export default class WakaBoxPlugin extends Plugin {
	settings: WakaBoxPluginSettings;
	private summaryFetcher: SummaryDataFetcher | undefined;

	async onload() {
		this.addSettingTab(new WakaBoxSettingTab(this.app, this));
		this.app.workspace.onLayoutReady(() => {
			this.onLayoutReady();
		});
	}

	onLayoutReady() {
		if (!appHasDailyNotesPluginLoaded()) {
			new Notice("WakaTime box: please enable daily notes plugin.", 5000);
		}
		this.loadSettings().then(() => {
			if (this.settings.apiKey.trim() == "") {
				new Notice(
					"WakaTime box: please enter your API key in the settings.",
					5000
				);
				return;
			}
			this.onGetAPIKey();
		});
	}

	// 共通処理を外部関数として抽出
	private fetchSummaryData(
		date: string,
		userInput: boolean,
		callback?: (summary: Summary | undefined, _: boolean) => void
	) {
		if (
			this.summaryFetcher == undefined ||
			this.settings.apiKey.trim() == ""
		) {
			new Notice(
				"WakaTime box: please enter your API key in the settings.",
				5000
			);
			return;
		}

		const finalCallback =
			callback ??
			(userInput
				? (summary: Summary | undefined, _: boolean) => {
						if (summary == undefined) {
							console.warn(
								"WakaTime box: no summary data received"
							);
							return;
						}
						const box = this.getBoxText(summary);
						navigator.clipboard.writeText(box).then(() => {
							new Notice(
								"WakaTime box: " +
									date +
									" copied to clipboard",
								3000
							);
						});
				  }
				: this.onFetchedSummary);

		this.summaryFetcher.requestWakaTimeSummary(
			this.settings.apiKey,
			date,
			true,
			finalCallback
		);
	}

	private registerCommand(id: string, name: string, callback: () => void) {
		this.addCommand({ id, name, callback });
	}

	private validateAndFetchDate(input: string) {
		try {
			const date = moment(input, "YYYY-MM-DD", true);
			if (!date.isValid()) {
				new Notice(
					"WakaTime box: Invalid date format. Use YYYY-MM-DD.",
					5000
				);
				return;
			}
			this.fetchSummaryData(date.format("YYYY-MM-DD"), true);
		} catch (e) {
			new Notice(`WakaTime box: Failed due to ${e}`, 5000);
		}
	}

	onGetAPIKey() {
		if (this.settings.apiKey.trim() == "") {
			return;
		}

		// コマンド登録
		this.addCommand({
			id: "refresh-today",
			name: "Force refetch today's data",
			callback: () => {
				const date = moment().format("YYYY-MM-DD");
				this.fetchSummaryData(date, false);
			},
		});

		this.addCommand({
			id: "refresh-yesterday",
			name: "Force refetch yesterday's data",
			callback: () => {
				const date = moment().subtract(1, "days").format("YYYY-MM-DD");
				this.fetchSummaryData(date, false);
			},
		});

		this.addCommand({
			id: "refresh-manual",
			name: "Fetch specific date's data and copy to clipboard",
			callback: () => {
				new ManualModal(this.app, (result: string) => {
					this.validateAndFetchDate(result);
				}).open();
			},
		});

		this.summaryFetcher = new SummaryDataFetcher(this.app);

		// ファイルを開いたときにデータを取得
		const fetchSummaryDataFromOpenDailyNote = () => {
			const activeFile = this.app.workspace.getActiveFile();
			if (!activeFile) {
				console.warn("WakaTime box: No active file found.");
				return;
			}

			// デイリーノートの日付を取得
			const dailyNotes = getAllDailyNotes();
			const dailyNote = Object.values(dailyNotes).find(
				(note) => note.path === activeFile.path
			);

			if (!dailyNote) {
				console.warn("WakaTime box: Active file is not a daily note.");
				return;
			}

			/**
			 * ファイル名から日付を抽出
			 * 以下の正規表現パターンに対応
			 * m.d.y
			 * yyyy年m月d日
			 * yyyy_mm_dd
			 * 令和元年1月1日
			 */
			const dateMatch = dailyNote.basename.match(
				/\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(日)?|[昭平成令\p{Script=Han}]{1,2}元?年\d{1,2}月\d{1,2}日|\d{1,2}[-_/]\d{1,2}[-_/]\d{4}/u
			);
			if (!dateMatch) {
				console.warn(
					"WakaTime box: Failed to extract date from daily note."
				);
				return;
			}

			const date = dateMatch[0];
			this.fetchSummaryData(date, false);
		};

		// インターバルチェックの設定
		const interval = 60 * 1000;
		let intervalMinutesCounter = 0;

		this.registerInterval(
			window.setInterval(() => {
				if (!this.settings.enableDailyBatchMode) {
					if (
						intervalMinutesCounter >=
						this.settings.updateIntervalMinutes
					) {
						intervalMinutesCounter = 0;
						fetchSummaryDataFromOpenDailyNote();
					}
					intervalMinutesCounter++;
				} else {
					const now = new Date();
					if (
						now.getHours() === this.settings.batchUpdateHours &&
						now.getMinutes() === this.settings.batchUpdateMinutes
					) {
						fetchSummaryDataFromOpenDailyNote();
					}
				}
			}, interval)
		);
	}

	onunload() {
		this.summaryFetcher = undefined;
	}

	onFetchedSummary = (summary: Summary | undefined, fromCache: boolean) => {
		if (summary == undefined) {
			console.warn("WakaTime box: no summary data received");
			return;
		}
		const momentDate = moment.utc(summary.start).local();
		const dailyNotes = getAllDailyNotes();
		const dailyNode = getDailyNote(momentDate, dailyNotes);
		if (dailyNode == undefined) {
			createDailyNote(momentDate).then((file) => {
				this.processDailyNote(file, summary, fromCache);
			});
		} else {
			this.processDailyNote(dailyNode, summary, fromCache);
		}
		if (!fromCache) {
			new Notice(
				"WakaTime box: " +
					momentDate.format("YYYY-MM-DD") +
					" refreshed",
				5000
			);
		}
	};

	processDailyNote(file: TFile, summary: Summary, fromCache: boolean) {
		console.log(
			"refreshing daily note. fromCache: " +
				fromCache +
				", file: " +
				file.name
		);
		this.app.vault.process(file, (data: string) => {
			let box = this.getBoxText(summary);
			const exists = data.includes("```wakatime");
			if (exists) {
				data = data.replace(/```wakatime[\s\S]*```/g, box);
			} else {
				data += box;
			}
			return data;
		});
	}

	private getBoxText(summary: Summary) {
		let box = "";
		box += "```wakatime";
		box += "\n";
		let count = 0;
		let maxNameLength = 0;
		let maxTextLength = 0;
		let maxPercentLength = 0;
		summary.data[0].languages.forEach((language) => {
			if (count++ > 5) {
				return;
			}
			if (language.name.length > maxNameLength) {
				maxNameLength = language.name.length;
			}
			if (language.text.length > maxTextLength) {
				maxTextLength = language.text.length;
			}
			if (language.percent.toString().length > maxPercentLength) {
				maxPercentLength = language.percent.toString().length;
			}
		});
		count = 0;
		summary.data[0].languages.forEach((language) => {
			if (count++ > 5) {
				return;
			}
			const name = language.name.padEnd(maxNameLength, " ");
			const text = language.text.padEnd(maxTextLength, " ");
			const percent = language.percent
				.toString()
				.padStart(maxPercentLength, " ");
			const bar = this.generateBarChart(language.percent, 20);
			const padding = " ".repeat(5);
			const line = `${name}${padding}${text}${padding}${bar}${padding}${percent} %\n`;
			box += line;
		});
		box += "```";
		return box;
	}

	generateBarChart(percent: number, size: number): string {
		const syms = "░▏▎▍▌▋▊▉█";

		const frac = Math.floor((size * 8 * percent) / 100);
		const barsFull = Math.floor(frac / 8);
		if (barsFull >= size) {
			return syms.substring(8, 9).repeat(size);
		}
		const semi = frac % 8;

		return [
			syms.substring(8, 9).repeat(barsFull),
			syms.substring(semi, semi + 1),
		]
			.join("")
			.padEnd(size, syms.substring(0, 1));
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SummaryDataFetcher {
	private app: App;
	private cacheDir: String;

	constructor(app: App) {
		this.app = app;
		this.createCacheDir();
	}

	async createCacheDir() {
		const cacheDir = normalizePath(
			this.app.vault.configDir + "/" + ".waka_box_cache"
		);
		const exists = await this.app.vault.adapter.exists(cacheDir);
		if (!exists) {
			await this.app.vault.adapter.mkdir(cacheDir);
		}
		this.cacheDir = cacheDir;
	}

	async loadFromCache(cacheKey: String): Promise<Summary | undefined> {
		await this.createCacheDir();
		const cacheFilePath = normalizePath(this.cacheDir + "/" + cacheKey);
		const exists = await this.app.vault.adapter.exists(cacheFilePath);
		const vaildTill = new Date();
		vaildTill.setHours(vaildTill.getHours() - 1);
		if (!exists) {
			return undefined;
		}
		try {
			const stat = await this.app.vault.adapter.stat(cacheFilePath);
			const metadata = stat?.mtime;
			if (metadata) {
				const lastModified = new Date(metadata);
				if (lastModified < vaildTill) {
					return undefined;
				}
			}

			const data = await this.app.vault.adapter.read(cacheFilePath);
			const summary = JSON.parse(data) as Summary;
			return summary;
		} catch (e) {
			console.error(
				"WakaTime box: Error loading WakaTime summary from cache: " + e
			);
		}
		return undefined;
	}

	async saveToCache(cacheKey: String, summary: Summary) {
		try {
			await this.app.vault.adapter.write(
				normalizePath(this.cacheDir + "/" + cacheKey),
				JSON.stringify(summary)
			);
		} catch (e) {
			console.error(
				"WakaTime box: Error saving WakaTime summary to cache: " + e
			);
		}
	}

	async fetchViaAPI(url: string, date: string): Promise<Summary | undefined> {
		console.log("start request for " + date);
		try {
			const result = await request(url);
			const summary = JSON.parse(result) as Summary;
			console.log("success request for " + date + " from wakatime API");
			this.saveToCache(date, summary);
			return summary;
		} catch (error) {
			console.error(
				"WakaTime box: error requesting WakaTime summary: " + error
			);
			new Notice(
				"WakaTime box: error requesting WakaTime summary: " + error,
				5000
			);
			return undefined;
		}
	}

	// read cache or fetch data from wakatime
	async requestWakaTimeSummary(
		apiKey: String,
		date: string,
		force: boolean,
		callback: (summary: Summary | undefined, fromCache: boolean) => void
	) {
		const baseUrl = "https://wakatime.com/api/v1/users/current/summaries";
		const url =
			baseUrl + "?start=" + date + "&end=" + date + "&api_key=" + apiKey;
		try {
			if (force) {
				const result = await this.fetchViaAPI(url, date);
				callback(result, false);
				return;
			}
			const cacheResult = await this.loadFromCache(date);
			if (cacheResult != undefined) {
				console.log("success request for " + date + " from cache");
				callback(cacheResult, true);
				return;
			}
			const apiResult = await this.fetchViaAPI(url, date);
			callback(apiResult, false);
		} catch (e) {
			console.error(
				"WakaTime box: error requesting WakaTime summary: " + e
			);
			new Notice(
				"WakaTime box: error requesting WakaTime summary: " + e,
				5000
			);
			callback(undefined, false);
		}
	}
}

class WakaBoxSettingTab extends PluginSettingTab {
	plugin: WakaBoxPlugin;

	constructor(app: App, plugin: WakaBoxPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl).setName("WakaTime API key").addText((text) =>
			text
				.setValue(this.plugin.settings.apiKey)
				.setPlaceholder("Enter your API key")
				.onChange(async (value) => {
					this.plugin.settings.apiKey = value;
					await this.plugin.saveSettings();
					this.plugin.onGetAPIKey();
				})
		);

		/* add for multi-devices */
		new Setting(containerEl)
			.setName("Enable Daily Batch Mode")
			.setDesc("Only update notes once per day")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableDailyBatchMode)
					.onChange(async (value) => {
						this.plugin.settings.enableDailyBatchMode = value;
						await this.plugin.saveSettings();
						this.toggleVisibility(
							value,
							IntervalContainer,
							DailyBatchContainer
						);
					})
			);

		// BatchModeの説明文を追加
		const descriptionEl = containerEl.createEl("p", {
			text: "When Batch Mode is ON, the plugin updates at the specified time. When OFF, it updates at the specified interval.",
		});
		descriptionEl.style.marginTop = "10px";
		descriptionEl.style.marginBottom = "10px";
		descriptionEl.style.color = "var(--text-muted)";

		// 罫線を追加
		containerEl.createEl("hr");

		// バッチモードの有効/無効に応じて時刻設定を制御
		const IntervalContainer = containerEl.createDiv();
		IntervalContainer.addClass("wakabox-time-setting");
		const DailyBatchContainer = containerEl.createDiv();
		DailyBatchContainer.addClass("wakabox-time-setting");
		this.toggleVisibility(
			this.plugin.settings.enableDailyBatchMode,
			IntervalContainer,
			DailyBatchContainer
		);

		this.createNumberInputSetting(
			IntervalContainer,
			"Update Interval (minutes)",
			"How often to update WakaTime data, in minutes (60-1440)",
			this.plugin.settings.updateIntervalMinutes,
			60,
			1440,
			async (value) => {
				this.plugin.settings.updateIntervalMinutes = value;
				await this.plugin.saveSettings();
			}
		);

		this.createNumberInputSetting(
			DailyBatchContainer,
			"Batch Update Hour",
			"Hour to update WakaTime data (0-23)",
			this.plugin.settings.batchUpdateHours,
			0,
			23,
			async (value) => {
				this.plugin.settings.batchUpdateHours = value;
				await this.plugin.saveSettings();
			}
		);

		this.createNumberInputSetting(
			DailyBatchContainer,
			"Batch Update Minute",
			"Minute to update WakaTime data (0-59)",
			this.plugin.settings.batchUpdateMinutes,
			0,
			59,
			async (value) => {
				this.plugin.settings.batchUpdateMinutes = value;
				await this.plugin.saveSettings();
			}
		);
	}

	private toggleVisibility(
		enableBatchMode: boolean,
		intervalContainer: HTMLElement,
		dailyBatchContainer: HTMLElement
	) {
		intervalContainer.style.display = enableBatchMode ? "none" : "block";
		dailyBatchContainer.style.display = enableBatchMode ? "block" : "none";
	}

	private createNumberInputSetting(
		container: HTMLElement,
		name: string,
		description: string,
		initialValue: number,
		min: number,
		max: number,
		onChange: (value: number) => Promise<void>
	) {
		new Setting(container)
			.setName(name)
			.setDesc(description)
			.addText((text) => {
				const inputEl = text.inputEl;
				inputEl.type = "number";
				inputEl.min = min.toString();
				inputEl.max = max.toString();
				inputEl.value = initialValue.toString();
				inputEl.style.width = "100px";
				inputEl.style.fontSize = "1.2em";
				inputEl.addEventListener("change", async () => {
					const value = parseInt(inputEl.value, 10);
					if (!isNaN(value) && value >= min && value <= max) {
						await onChange(value);
					} else {
						new Notice(
							`Please enter a valid number between ${min} and ${max}.`,
							3000
						);
						inputEl.value = initialValue.toString();
					}
				});
			});
	}
}

export class ManualModal extends Modal {
	onResult: (result: string) => void;
	result: string = "";

	constructor(app: App, onResult: (result: string) => void) {
		super(app);
		this.onResult = onResult;
	}

	onOpen() {
		let { contentEl } = this;
		contentEl.createEl("h1", { text: "Manual fetch WakaTime box" });

		new Setting(contentEl)
			.setName("Enter the date you want to fetch")
			.setDesc("Format: YYYY-MM-DD")
			.addText((text) => {
				const date = moment().format("YYYY-MM-DD");
				text.setValue(date);
				text.onChange((value) => {
					this.result = value;
				});
			});

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText("Submit")
				.setCta()
				.onClick(() => {
					this.close();
					this.onResult(this.result);
				})
		);
	}

	onClose() {
		let { contentEl } = this;
		contentEl.empty();
	}
}
