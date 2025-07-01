import { Client, GatewayIntentBits, VoiceBasedChannel, Message, Collection, SlashCommandBuilder, REST, Routes, ChatInputCommandInteraction } from 'discord.js';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import kuromoji from 'kuromoji';

dotenv.config();

// Kuromoji の Tokenizer インスタンス
let tokenizer: any;

// Kuromoji Tokenizer の初期化
kuromoji.builder({ dicPath: 'node_modules/kuromoji/dict' }).build((err: any, builtTokenizer: any) => {
    if (err) {
        console.error('Kuromoji build error:', err);
        process.exit(1);
    }
    tokenizer = builtTokenizer;
    console.log('Kuromoji tokenizer ready.');
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

// better-sqlite3 データベース初期化
const db = new Database('markov_chain.db');

// テーブル作成
db.exec("CREATE TABLE IF NOT EXISTS markov_chain (prefix1 TEXT, prefix2 TEXT, suffix TEXT, UNIQUE(prefix1, prefix2, suffix))");

// --- Promise-based DB functions for better-sqlite3 ---
function dbGet(query: string, params: any[]): any {
    try {
        return db.prepare(query).get(...params);
    } catch (error) {
        console.error('Database get error:', error);
        return null;
    }
}

function dbAll(query: string, params: any[]): any[] {
    try {
        return db.prepare(query).all(...params);
    } catch (error) {
        console.error('Database all error:', error);
        return [];
    }
}
// --------------------------------

const INACTIVE_CHANNEL_ID = process.env.INACTIVE_CHANNEL_ID;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const MESSAGE_CRAWLING_ID = process.env.MESSAGE_CRAWLING_ID;
const CLIENT_ID = process.env.CLIENT_ID; // アプリケーションIDが必要
const ADMIN_USER_ID = process.env.ADMIN_USER_ID; // 管理者ユーザーID

if (!INACTIVE_CHANNEL_ID || !DISCORD_BOT_TOKEN || !MESSAGE_CRAWLING_ID || !CLIENT_ID) {
    console.error('One or more environment variables are not defined in .env file.');
    console.error('Required: INACTIVE_CHANNEL_ID, DISCORD_BOT_TOKEN, MESSAGE_CRAWLING_ID, CLIENT_ID');
    console.error('Optional: ADMIN_USER_ID (for crawling command restrictions)');
    process.exit(1);
}

const userMuteStartTime = new Map<string, number>();

// 自動応答の設定
let autoResponseMode: 'mention_only' | 'random' | 'disabled' = 'random';

// スラッシュコマンドの定義
const commands = [
    new SlashCommandBuilder()
        .setName('crawling')
        .setDescription('メッセージをクロールしてマルコフ連鎖データベースを更新します')
        .addIntegerOption(option =>
            option.setName('count')
                .setDescription('取得するメッセージ数（デフォルト: 2000）')
                .setRequired(false)
                .setMinValue(100)
                .setMaxValue(10000)
        ),
    new SlashCommandBuilder()
        .setName('generate')
        .setDescription('マルコフ連鎖を使用して文章を生成します')
        .addIntegerOption(option =>
            option.setName('length')
                .setDescription('生成する最大単語数（デフォルト: 50）')
                .setRequired(false)
                .setMinValue(10)
                .setMaxValue(200)
        )
        .addStringOption(option =>
            option.setName('input')
                .setDescription('この文章を元に応答を生成します（省略時はランダム生成）')
                .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('stats')
        .setDescription('データベースの統計情報を表示します'),
    new SlashCommandBuilder()
        .setName('autoresponse')
        .setDescription('自動応答機能の設定を変更します')
        .addStringOption(option =>
            option.setName('mode')
                .setDescription('自動応答モード')
                .setRequired(true)
                .addChoices(
                    { name: '有効（メンション時のみ）', value: 'mention_only' },
                    { name: '有効（ランダム応答あり）', value: 'random' },
                    { name: '無効', value: 'disabled' }
                )
        )
].map(command => command.toJSON());

// スラッシュコマンドの登録
const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);

async function deployCommands() {
    try {
        console.log('Started refreshing application (/) commands.');

        // テスト用：特定のギルド（サーバー）にコマンドを登録（即座に反映）
        const GUILD_ID = process.env.GUILD_ID; // .envに追加
        
        if (GUILD_ID) {
            await rest.put(
                Routes.applicationGuildCommands(CLIENT_ID!, GUILD_ID),
                { body: commands },
            );
            console.log('Successfully reloaded guild-specific (/) commands.');
        } else {
            // グローバルコマンド（反映に時間がかかる）
            await rest.put(
                Routes.applicationCommands(CLIENT_ID!),
                { body: commands },
            );
            console.log('Successfully reloaded global (/) commands.');
        }
    } catch (error) {
        console.error('Error deploying commands:', error);
    }
}

client.once('ready', async () => {
    console.log(`Logged in as ${client.user?.tag}!`);
    
    // スラッシュコマンドをデプロイ
    await deployCommands();

    setInterval(() => {
        for (const [userId, muteStartTime] of userMuteStartTime.entries()) {
            client.guilds.cache.forEach(guild => {
                const voiceState = guild.voiceStates.cache.get(userId);

                if (voiceState && voiceState.channelId && voiceState.channelId !== INACTIVE_CHANNEL_ID) {
                    if (voiceState.selfMute || voiceState.serverMute) {
                        const currentTime = Date.now();
                        const timeElapsed = currentTime - muteStartTime;

                        if (timeElapsed >= 30 * 60 * 1000) {
                            const inactiveChannel = guild.channels.cache.get(INACTIVE_CHANNEL_ID) as VoiceBasedChannel;
                            if (inactiveChannel && voiceState.member) {
                                voiceState.setChannel(inactiveChannel).catch(console.error);
                                userMuteStartTime.delete(userId);
                            }
                        }
                    } else {
                        userMuteStartTime.delete(userId);
                    }
                } else {
                    userMuteStartTime.delete(userId);
                }
            });
        }
    }, 60 * 1000);
});

client.on('voiceStateUpdate', (oldState, newState) => {
    const userId = newState.member?.id;
    if (!userId) return;

    const wasMuted = oldState.selfMute || oldState.serverMute;
    const isMuted = newState.selfMute || newState.serverMute;

    if (newState.channelId) {
        if (!wasMuted && isMuted) {
            userMuteStartTime.set(userId, Date.now());
        } else if (wasMuted && !isMuted) {
            userMuteStartTime.delete(userId);
        }
        if (newState.channelId === INACTIVE_CHANNEL_ID) {
            userMuteStartTime.delete(userId);
        }
    } else if (oldState.channelId && !newState.channelId) {
        userMuteStartTime.delete(userId);
    }
});

async function generateMarkovSentence(maxWords = 50): Promise<string> {
    try {
        const startRow = dbGet('SELECT prefix1, prefix2 FROM markov_chain ORDER BY RANDOM() LIMIT 1', []);
        if (!startRow) {
            return "データベースに十分なデータがありません。";
        }

        let { prefix1, prefix2 } = startRow;
        const sentence = [prefix1, prefix2];

        for (let i = 0; i < maxWords; i++) {
            const suffixes = dbAll('SELECT suffix FROM markov_chain WHERE prefix1 = ? AND prefix2 = ?', [prefix1, prefix2]);
            if (suffixes.length === 0) {
                break;
            }

            const nextSuffix = suffixes[Math.floor(Math.random() * suffixes.length)].suffix;
            sentence.push(nextSuffix);

            prefix1 = prefix2;
            prefix2 = nextSuffix;
        }

        return sentence.join('');
    } catch (error) {
        console.error("Error generating sentence:", error);
        return "文章の生成中にエラーが発生しました。";
    }
}

async function generateResponseFromMessage(inputMessage: string, maxWords = 50): Promise<string> {
    try {
        if (!tokenizer) {
            return "トークナイザーが準備できていません。";
        }

        // 入力メッセージをトークン化
        const tokens = tokenizer.tokenize(inputMessage);
        const words = tokens.map((t: any) => t.surface_form);
        
        if (words.length < 2) {
            // 短すぎる場合はランダム生成
            return await generateMarkovSentence(maxWords);
        }

        // 入力メッセージの最後の2単語を取得
        const lastTwoWords = words.slice(-2);
        let prefix1 = lastTwoWords[0];
        let prefix2 = lastTwoWords[1] || "";

        // 入力の最後の単語から始まる連鎖を探す
        let startCandidates = dbAll('SELECT prefix1, prefix2 FROM markov_chain WHERE prefix1 = ? OR prefix2 = ?', [prefix1, prefix2]);
        
        // 候補がない場合は、入力メッセージの任意の単語を使用
        if (startCandidates.length === 0) {
            for (const word of words) {
                startCandidates = dbAll('SELECT prefix1, prefix2 FROM markov_chain WHERE prefix1 = ? OR prefix2 = ?', [word, word]);
                if (startCandidates.length > 0) {
                    break;
                }
            }
        }

        // それでも見つからない場合はランダム生成
        if (startCandidates.length === 0) {
            return await generateMarkovSentence(maxWords);
        }

        // ランダムに開始点を選択
        const startPoint = startCandidates[Math.floor(Math.random() * startCandidates.length)];
        prefix1 = startPoint.prefix1;
        prefix2 = startPoint.prefix2;

        const sentence = [prefix1, prefix2];

        // マルコフ連鎖で文章を生成
        for (let i = 0; i < maxWords; i++) {
            const suffixes = dbAll('SELECT suffix FROM markov_chain WHERE prefix1 = ? AND prefix2 = ?', [prefix1, prefix2]);
            if (suffixes.length === 0) {
                break;
            }

            const nextSuffix = suffixes[Math.floor(Math.random() * suffixes.length)].suffix;
            sentence.push(nextSuffix);

            prefix1 = prefix2;
            prefix2 = nextSuffix;
        }

        const result = sentence.join('');
        
        // 結果が短すぎる場合は再試行
        if (result.length < 10) {
            return await generateMarkovSentence(maxWords);
        }

        return result;
    } catch (error) {
        console.error("Error generating response from message:", error);
        return "応答の生成中にエラーが発生しました。";
    }
}

async function handleCrawlingCommand(interaction: ChatInputCommandInteraction) {
    // 管理者権限チェック
    if (ADMIN_USER_ID && interaction.user.id !== ADMIN_USER_ID) {
        await interaction.reply({ 
            content: '❌ このコマンドは管理者のみ実行できます。', 
            ephemeral: true 
        });
        return;
    }

    if (!tokenizer) {
        await interaction.reply({ content: 'Tokenizer is not ready yet. Please wait a moment and try again.', ephemeral: true });
        return;
    }

    const messageCount = interaction.options.getInteger('count') ?? 2000;

    const channelToCrawl = await client.channels.fetch(MESSAGE_CRAWLING_ID!);
    if (!channelToCrawl || !channelToCrawl.isTextBased()) {
        await interaction.reply({ content: 'The channel specified in MESSAGE_CRAWLING_ID is not a valid text channel.', ephemeral: true });
        return;
    }

    await interaction.reply(`🔍 クロールを開始しました... ${messageCount}件のメッセージを取得します。しばらくお待ちください。`);
    console.log(`Crawling started for ${messageCount} messages by user: ${interaction.user.tag} (${interaction.user.id})`);

    let lastId: string | undefined;
    const allMessages: Message[] = [];
    const fetchLimit = 100;

    try {
        // メッセージ取得フェーズ
        while (allMessages.length < messageCount) {
            const options: { limit: number; before?: string } = { limit: fetchLimit };
            if (lastId) {
                options.before = lastId;
            }

            const messages: Collection<string, Message> = await channelToCrawl.messages.fetch(options);
            if (messages.size === 0) break;
            
            const messageArray = Array.from(messages.values());
            for (const msg of messageArray) {
                if (allMessages.length < messageCount) {
                    allMessages.push(msg);
                } else {
                    break;
                }
            }
            
            lastId = messageArray[messageArray.length - 1].id;
            console.log(`Fetched ${allMessages.length}/${messageCount} messages...`);
            
            // 進捗を更新（1000件ごと）
            if (allMessages.length % 1000 === 0) {
                await interaction.editReply(`🔍 ${allMessages.length}/${messageCount} 件のメッセージを取得しました...`);
            }
            
            if (messages.size < fetchLimit) break;
        }

        console.log(`Total messages fetched: ${allMessages.length}. Now processing...`);
        await interaction.editReply(`📊 ${allMessages.length}件のメッセージを取得完了。データベースに保存中...`);

        // データベース処理フェーズ - better-sqlite3のトランザクション使用
        const insertStmt = db.prepare("INSERT OR IGNORE INTO markov_chain (prefix1, prefix2, suffix) VALUES (?, ?, ?)");
        
        const transaction = db.transaction((messages: Message[]) => {
            let processedMessages = 0;
            let insertedChains = 0;

            for (const msg of messages) {
                if (!msg.content) continue;
                
                try {
                    const tokens = tokenizer.tokenize(msg.content);
                    const words = tokens.map((t: any) => t.surface_form);

                    if (words.length < 3) continue;

                    for (let i = 0; i < words.length - 2; i++) {
                        if (words[i] && words[i + 1] && words[i + 2]) {
                            const result = insertStmt.run(words[i], words[i + 1], words[i + 2]);
                            if (result.changes > 0) {
                                insertedChains++;
                            }
                        }
                    }
                    processedMessages++;
                } catch (tokenizeError) {
                    console.error('Error tokenizing message:', tokenizeError);
                    continue;
                }
            }

            console.log(`Processed ${processedMessages} messages, inserted ${insertedChains} new markov chains.`);
            return { processedMessages, insertedChains };
        });

        // トランザクション実行
        const result = transaction(allMessages);
        
        console.log('Crawling finished.');
        await interaction.editReply(`✅ クロール完了！\n📝 ${result.processedMessages}件のメッセージを処理し、${result.insertedChains}個の新しいマルコフ連鎖をデータベースに追加しました。`);

    } catch (error) {
        console.error('An error occurred during crawling:', error);
        await interaction.editReply('❌ クロール中にエラーが発生しました。コンソールで詳細を確認してください。');
    }
}

async function handleGenerateCommand(interaction: ChatInputCommandInteraction) {
    const maxWords = interaction.options.getInteger('length') ?? 50;
    const inputText = interaction.options.getString('input');
    
    await interaction.deferReply();
    
    try {
        let sentence: string;
        
        if (inputText) {
            // 入力テキストを元に応答生成
            sentence = await generateResponseFromMessage(inputText, maxWords);
        } else {
            // ランダム生成
            sentence = await generateMarkovSentence(maxWords);
        }
        
        await interaction.editReply(`🤖 生成された文章:\n\n${sentence}`);
    } catch (error) {
        console.error('Error generating sentence:', error);
        await interaction.editReply('❌ 文章生成中にエラーが発生しました。');
    }
}

async function handleAutoResponseCommand(interaction: ChatInputCommandInteraction) {
    const mode = interaction.options.getString('mode') as 'mention_only' | 'random' | 'disabled';
    
    autoResponseMode = mode;
    
    const modeDescriptions = {
        'mention_only': '🔔 メンション時のみ自動応答',
        'random': '🎲 ランダム自動応答有効（50%の確率 + メンション時）',
        'disabled': '🔕 自動応答無効'
    };
    
    await interaction.reply(`⚙️ 自動応答設定を変更しました: ${modeDescriptions[mode]}`);
}

// 新しいhandleStatsCommand関数は上記で既に更新済み

// スラッシュコマンドの処理
client.on('interactionCreate', async (interaction) => {
    console.log('Interaction received:', interaction.type, interaction.user.tag);
    
    if (!interaction.isChatInputCommand()) {
        console.log('Not a chat input command');
        return;
    }

    const { commandName } = interaction;
    console.log('Slash command received:', commandName);

    try {
        switch (commandName) {
            case 'crawling':
                await handleCrawlingCommand(interaction);
                break;
            case 'generate':
                await handleGenerateCommand(interaction);
                break;
            case 'autoresponse':
                await handleAutoResponseCommand(interaction);
                break;
            default:
                await interaction.reply({ content: '不明なコマンドです。', ephemeral: true });
        }
    } catch (error) {
        console.error('Error handling slash command:', error);
        
        const errorMessage = 'コマンドの実行中にエラーが発生しました。';
        
        if (interaction.replied || interaction.deferred) {
            await interaction.editReply(errorMessage);
        } else {
            await interaction.reply({ content: errorMessage, ephemeral: true });
        }
    }
});

// 既存のメッセージコマンドも保持（下位互換性のため）+ 自動応答機能
client.on('messageCreate', async (message: Message) => {
    const { channel } = message;
    if (message.author.bot || !channel.isTextBased()) {
        return;
    }

    // 下位互換性のため、従来のコマンドも残す
    if (message.content === '!crawling') {
        await message.reply('このコマンドはスラッシュコマンドに移行しました。`/crawling` を使用してください。');
        return;
    } else if (message.content === '!generate') {
        await message.reply('このコマンドはスラッシュコマンドに移行しました。`/generate` を使用してください。');
        return;
    } else if (message.content === '!stats') {
        await message.reply('このコマンドはスラッシュコマンドに移行しました。`/stats` を使用してください。');
        return;
    }

    // 自動応答機能（設定に応じて反応）
    if (autoResponseMode !== 'disabled' && message.content.length > 5) {
        const isMentioned = message.mentions.has(client.user!);
        const shouldRespond = isMentioned || (autoResponseMode === 'random' && Math.random() < 0.5);
        
        if (shouldRespond) {
            try {
                // タイピング表示を開始
                if("sendTyping" in channel){
                    await channel.sendTyping();
                }
                
                // 少し待機（自然な感じにするため）
                setTimeout(async () => {
                    const response = await generateResponseFromMessage(message.content);
                    
                    // メンションされた場合は返信、そうでなければ通常のメッセージ
                    if (isMentioned) {
                        await message.reply(response);
                    } else {
                        if("send" in message.channel) {
                            await message.channel.send(response);
                        }
                    }
                }, Math.random() * 2000 + 1000); // 1-3秒のランダムな遅延
                
            } catch (error) {
                console.error('Error in auto-response:', error);
            }
        }
    }
});

// グレースフルシャットダウン
process.on('SIGINT', () => {
    console.log('Received SIGINT. Closing database and shutting down...');
    db.close();
    client.destroy();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM. Closing database and shutting down...');
    db.close();
    client.destroy();
    process.exit(0);
});

client.login(DISCORD_BOT_TOKEN);