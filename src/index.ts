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

if (!INACTIVE_CHANNEL_ID || !DISCORD_BOT_TOKEN || !MESSAGE_CRAWLING_ID || !CLIENT_ID) {
    console.error('One or more environment variables are not defined in .env file.');
    console.error('Required: INACTIVE_CHANNEL_ID, DISCORD_BOT_TOKEN, MESSAGE_CRAWLING_ID, CLIENT_ID');
    process.exit(1);
}

const userMuteStartTime = new Map<string, number>();

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
        ),
    new SlashCommandBuilder()
        .setName('stats')
        .setDescription('データベースの統計情報を表示します')
].map(command => command.toJSON());

// スラッシュコマンドの登録
const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);

async function deployCommands() {
    try {
        console.log('Started refreshing application (/) commands.');

        await rest.put(
            Routes.applicationCommands(CLIENT_ID!),
            { body: commands },
        );

        console.log('Successfully reloaded application (/) commands.');
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

async function handleCrawlingCommand(interaction: ChatInputCommandInteraction) {
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
    console.log(`Crawling started for ${messageCount} messages...`);

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
    
    await interaction.deferReply();
    
    try {
        const sentence = await generateMarkovSentence(maxWords);
        await interaction.editReply(`🤖 生成された文章:\n\n${sentence}`);
    } catch (error) {
        console.error('Error generating sentence:', error);
        await interaction.editReply('❌ 文章生成中にエラーが発生しました。');
    }
}

async function handleStatsCommand(interaction: ChatInputCommandInteraction) {
    try {
        const totalChains = dbGet('SELECT COUNT(*) as count FROM markov_chain', []);
        const uniquePrefixes = dbGet('SELECT COUNT(DISTINCT prefix1 || prefix2) as count FROM markov_chain', []);
        
        await interaction.reply(`📈 **データベース統計**\n🔗 総マルコフ連鎖数: ${totalChains?.count || 0}\n🏷️ ユニークなプレフィックス数: ${uniquePrefixes?.count || 0}`);
    } catch (error) {
        console.error('Error getting stats:', error);
        await interaction.reply({ content: '❌ データベース統計の取得中にエラーが発生しました。', ephemeral: true });
    }
}

// スラッシュコマンドの処理
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    try {
        switch (commandName) {
            case 'crawling':
                await handleCrawlingCommand(interaction);
                break;
            case 'generate':
                await handleGenerateCommand(interaction);
                break;
            case 'stats':
                await handleStatsCommand(interaction);
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

// 既存のメッセージコマンドも保持（下位互換性のため）
client.on('messageCreate', async (message: Message) => {
    const { channel } = message;
    if (message.author.bot || !channel.isTextBased()) {
        return;
    }

    // 下位互換性のため、従来のコマンドも残す
    if (message.content === '!crawling') {
        await message.reply('このコマンドはスラッシュコマンドに移行しました。`/crawling` を使用してください。');
    } else if (message.content === '!generate') {
        await message.reply('このコマンドはスラッシュコマンドに移行しました。`/generate` を使用してください。');
    } else if (message.content === '!stats') {
        await message.reply('このコマンドはスラッシュコマンドに移行しました。`/stats` を使用してください。');
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