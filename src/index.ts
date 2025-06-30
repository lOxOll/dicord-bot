import { Client, GatewayIntentBits, VoiceBasedChannel } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
    ]
});

// ユーザーがミュート状態になった時刻を記録するMap
const userMuteStartTime = new Map<string, number>(); // <userId, muteTimestamp>

const INACTIVE_CHANNEL_ID = process.env.INACTIVE_CHANNEL_ID; // 休止チャンネルのIDを.envファイルから取得
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN; // Botのトークンを.envファイルから取得

if (!INACTIVE_CHANNEL_ID) {
    console.error('INACTIVE_CHANNEL_ID is not defined in .env file.');
    process.exit(1);
}

if (!DISCORD_BOT_TOKEN) {
    console.error('DISCORD_BOT_TOKEN is not defined in .env file.');
    process.exit(1);
}

client.once('ready', () => {
    console.log(`Logged in as ${client.user?.tag}!`);

    // 1分ごとにミュート状態のユーザーをチェック
    setInterval(() => {
        for (const [userId, muteStartTime] of userMuteStartTime.entries()) {
            client.guilds.cache.forEach(guild => {
                const voiceState = guild.voiceStates.cache.get(userId);

                // ユーザーがまだボイスチャンネルにいて、休止チャンネル以外にいるか確認
                if (voiceState && voiceState.channelId && voiceState.channelId !== INACTIVE_CHANNEL_ID) {
                    // ユーザーがまだミュート状態であるか確認
                    if (voiceState.selfMute || voiceState.serverMute) {
                        const currentTime = Date.now();
                        const timeElapsed = currentTime - muteStartTime;

                        // 30分 (30 * 60 * 1000 ミリ秒) 以上経過しているかチェック
                        if (timeElapsed >= 30 * 60 * 1000) {
                            const inactiveChannel = guild.channels.cache.get(INACTIVE_CHANNEL_ID) as VoiceBasedChannel;
                            if (inactiveChannel && voiceState.member) {
                                console.log(`Moving muted user ${voiceState.member.user.tag} to inactive channel.`);
                                voiceState.setChannel(inactiveChannel)
                                    .then(() => console.log(`Moved ${voiceState.member?.user.tag} to ${inactiveChannel.name}`))
                                    .catch(console.error);
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
    }, 600 * 1000);
});

client.on('voiceStateUpdate', (oldState, newState) => {
    const userId = newState.member?.id;

    if (!userId) return;

    const wasMuted = oldState.selfMute || oldState.serverMute;
    const isMuted = newState.selfMute || newState.serverMute;

    if (newState.channelId) {
        // ミュート状態になった時
        if (!wasMuted && isMuted) {
            console.log(`User ${newState.member?.user.tag} became muted in ${newState.channel?.name}`);
            userMuteStartTime.set(userId, Date.now());
        }
        // ミュート状態が解除された時
        else if (wasMuted && !isMuted) {
            console.log(`User ${newState.member?.user.tag} became unmuted in ${newState.channel?.name}`);
            userMuteStartTime.delete(userId);
        }
        // チャンネル移動などでミュート状態が変わらない場合、何もしない
        // ただし、休止チャンネルに移動した場合は、ミュート状態に関わらず記録を削除
        if (newState.channelId === INACTIVE_CHANNEL_ID) {
            userMuteStartTime.delete(userId);
        }
    }
    else if (oldState.channelId && !newState.channelId) {
        console.log(`User ${oldState.member?.user.tag} left voice channel.`);
        userMuteStartTime.delete(userId);
    }
});

client.login(DISCORD_BOT_TOKEN);
