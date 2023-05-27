import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fs from "fs";
import axios from 'axios';

import pkg_t from 'telegraf';
const { Telegraf } = pkg_t;
import { message, editedMessage, channelPost, editedChannelPost, callbackQuery } from "telegraf/filters";

import ffmpeg from 'fluent-ffmpeg';
import { Configuration, OpenAIApi } from 'openai';

if (fs.existsSync(".env")) {
  dotenv.config();
}

if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.OPENAI_API_KEY || !process.env.DATABASE_URL) {
  throw new Error(
    "Please set the TELEGRAM_BOT_TOKEN and OPENAI_API_KEY and DATABASE_URL environment variables"
  );
}

// Connect to the postgress database

import pkg_pg from 'pg';
const { Pool } = pkg_pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});


// Database functions

const selectMessagesBuChatIdGPTformat = async (chatId) => {
  const res = await pool.query('SELECT role, content FROM messages WHERE chat_id = $1 ORDER BY id', [chatId]);
  return res.rows;
}

const insertMessage = async (role, content, chat_id) => {
  const res = await pool.query('INSERT INTO messages (role, content, chat_id) VALUES ($1, $2, $3)', [role, content, chat_id]);
  return res;
}

const deleteMessagesByChatId = async (chat_id) => {
  const res = await pool.query('DELETE FROM messages WHERE chat_id = $1', [chat_id]);
  return res;
}

// default prompt message to add to the GPT-4 model
const defaultPromptMessage = (
`Act as assistant
Your name is Donna
You are female
You should be friendly
You should not use official tone
Your answers should be simple, and laconic but informative
Before providing an answer check information above one more time
Try to solve tasks step by step
I will send you questions or topics to discuss and you will answer me
You interface right now is a telegram messenger
Some of messages you will receive from user was transcribed from voice messages
`)
const defaultPromptMessageObj = {
  "role": "assistant",
  "content": defaultPromptMessage,
};

// OpenAI functions

function createChatCompletionWithRetry(messages, retries = 5) {
  // Calculate total length of messages and prompt
  let totalLength = messages.reduce((acc, message) => acc + message.content.length, 0) + defaultPromptMessage.length;
  
  // lettersThreshold is the approximate limit of tokens for GPT-4 in letters
  let messagesCleanned;

  const lettersThreshold = 15000;
  
  if (totalLength <= lettersThreshold) {
      messagesCleanned = [...messages]; // create a copy of messages if totalLength is within limit
  } else {
      // If totalLength exceeds the limit, create a subset of messages
      const messagesCopy = [...messages].reverse(); // create a reversed copy of messages
      messagesCleanned = [];
  
      while (totalLength > lettersThreshold) {
          const message = messagesCopy.pop(); // remove the last message from the copy
          totalLength -= message.content.length; // recalculate the totalLength
      }
  
      messagesCleanned = messagesCopy.reverse(); // reverse the messages back to the original order
  }
  
  return openai.createChatCompletion({
    model: "gpt-4",
    messages: [defaultPromptMessageObj, ...messagesCleanned],
    temperature: 0.7,
  })
  .catch((error) => {
    if (retries === 0) {
      throw error;
    }
    console.error(`openai.createChatCompletion failed. Retries left: ${retries}`);
    return createChatCompletionWithRetry(messages, retries - 1);
  });
}

function createTranscriptionWithRetry(fileStream, retries = 3) {
  return openai.createTranscription(fileStream, "whisper-1")
    .catch((error) => {
      if (retries === 0) {
        throw error;
      }
      console.error(`openai.createTranscription failed. Retries left: ${retries}`);
      return createTranscriptionWithRetry(fileStream, retries - 1);
    });
}


// BOT

const configuration = new Configuration({
	apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.use(async (ctx, next) => {
  const start = new Date()
  await next()
  const ms = new Date() - start
  console.log(`New message from user ${ctx.from.username}. Response time: ${ms} ms.`)
})

const helpString = 'Бот GPT Кирилла Маркина - голосовой помощник, который понимает аудиосообщения на русском языке 😊'
bot.start((ctx) => {
  ctx.reply(helpString)
});
bot.help((ctx) => {
  ctx.reply(helpString)
});

bot.command('reset', (ctx) => {
  deleteMessagesByChatId(ctx.chat.id);
  ctx.reply('Старые сообщения удалены из памяти бота в этом чате.')
});


bot.on(message('photo'), (ctx) => {
  ctx.reply('Робот пока что не умеет работать с фото и проигнорирует это сообщение.');
});
bot.on(message('video'), (ctx) => {
  ctx.reply('Робот пока что не умеет работать с видео и проигнорирует это сообщение.');
});
bot.on(message('sticker'), (ctx) => ctx.reply('👍'));
bot.on(message('voice'), async (ctx) => {
  // whait for 1-3 seconds and sendChatAction typing
  const delay = Math.floor(Math.random() * 3) + 1;
  setTimeout(() => {
    ctx.telegram.sendChatAction(ctx.chat.id, 'typing');
  }
  , delay * 1000);

  try {
    const fileId = ctx.message.voice.file_id;

    // download the file
    const url = await ctx.telegram.getFileLink(fileId);
    const response = await axios({url, responseType: 'stream'});

    await new Promise((resolve, reject) => {
      response.data.pipe(fs.createWriteStream(`./${fileId}.oga`))
        .on('error', reject)
        .on('finish', resolve);
    });

    await new Promise((resolve, reject) => {
      ffmpeg(`./${fileId}.oga`)
        .toFormat('mp3')
        .on('error', reject)
        .on('end', resolve)
        .saveToFile(`./${fileId}.mp3`);
    });

    // send the file to the OpenAI API for transcription
    const transcription = await createTranscriptionWithRetry(fs.createReadStream(`./${fileId}.mp3`));
    const transcriptionText = transcription.data.text;

    // download all related messages from the database
    let messages = await selectMessagesBuChatIdGPTformat(ctx.chat.id);

    // Union the user message with messages
    messages = messages.concat({
      role: "user",
      content: transcriptionText,
    });

    // save the transcription to the database
    await insertMessage("user", transcriptionText, ctx.chat.id);

    // Send this text to OpenAI's Chat GPT-4 model with retry logic
    const chatResponse = await createChatCompletionWithRetry(messages);

    // save the answer to the database
    const answer = chatResponse.data.choices[0].message.content;
    await insertMessage("assistant", answer, ctx.chat.id);

    // send the answer to the user
    ctx.reply(answer);

    // Delete both files
    fs.unlink(`./${fileId}.oga`, (err) => {
      if (err) {
        console.error(err);
      }
    });
    fs.unlink(`./${fileId}.mp3`, (err) => {
      if (err) {
        console.error(err);
      }
    });
  } catch (e) {
    console.error("An error has occurred:", e);
  }
});

bot.on(message('text'), async (ctx) => {
  // whait for 1-3 seconds and sendChatAction typing
  const delay = Math.floor(Math.random() * 3) + 1;
  setTimeout(() => {
    ctx.telegram.sendChatAction(ctx.chat.id, 'typing');
  }
  , delay * 1000);

  try {
    const userText = ctx.message.text;

    // download all related messages from the database
    let messages = await selectMessagesBuChatIdGPTformat(ctx.chat.id);

    // save the message to the database
    await insertMessage("user", userText, ctx.chat.id);

    // Union the user message with messages
    messages = messages.concat({
      role: "user",
      content: userText,
    });

    // Send this text to OpenAI's Chat GPT-4 model with retry logic
    let response = await createChatCompletionWithRetry(messages);
  
    // save the answer to the database
    const answer = response.data.choices[0].message.content;
    await insertMessage("assistant", answer, ctx.chat.id);

    // send the the answer to the user
    ctx.reply(answer);
  } catch(e) {
    console.error("An error has occurred during the chatGPT completion process:", e);
  }
});
bot.launch()


// Web APP

const app = express();
const PORT = process.env.PORT || 5000;
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const router = express.Router();

app.get("/", (req, res) => {
  res
    .status(405)
    .send(
      "405 Method Not Allowed."
    );
});

app.get("/webhook", (req, res) => {
  res
    .status(405)
    .send(
      "405 Method Not Allowed."
    );
});

app.use("/", router);

app.listen(PORT, (err) => {
  if (err) {
    console.error(err);
  }
  console.log(`Server listening on port ${PORT}`);
});
