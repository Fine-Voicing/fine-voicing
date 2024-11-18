# Fine Voicing

Fine Voicing is a tool to evaluate the quality of voice assistants.

Features:
- Generate conversations with a voice assistant, using text or TTS.
- Evaluate the conversation quality.
- Evaluate the extracted information.

## Installation

```bash
npm install
```

## Usage

```bash
npm start
```

## Test Suite

The test suite is a collection of test cases that are used to evaluate the voice assistant.

To add a new test case, create a new JSON file in the `test-suites` directory and add the test case to the file.
Use the `test-suites/test.example.json` as a template.

```json
{
    "voice_model": {
        "provider": "openai",
        "model": "realtime",
        "voice": "alloy",
        "api_key": "your_api_key_here"
    },
    "instructions": "You're an helpful assistant speaking with a human being or an AI assistant",
    "test_mode": "text", // text or tts
    "turns": 1 // number of conversation turns to be generated
}
```

## Configuration

The configuration is done through the `config.json` file.
Use the `config.example.json` as a template.

```json
{ 
    "conversation_generator": {
        "provider": "openai",
        "model": "gpt-4o-mini",
        "api_key": "your_api_key_here",
        "system_prompt_path": "./prompts/defaults/conversation-generation.txt"
    },
    "conversation_evaluator": {
        "conversation": {
            "provider": "openai",
            "model": "gpt-4o-mini",
            "api_key": "your_api_key_here",
            "system_prompt_path": "./prompts/defaults/conversation-evaluation.txt"
        },
        "information_extraction": {
            "provider": "openai",
            "model": "gpt-4o-mini",
            "api_key": "your_api_key_here",
            "system_prompt_path": "./prompts/defaults/conversation-information-extraction.txt"
        }
    },
    "test_suite": {
        "dir": "./test-suites",
        "results_dir": "./test-results"
    }
}
```

## Prompts

Prompts are located in the `prompts` directory.
Three default prompts are provided:
- `conversation-generation.txt`: Used to generate conversations.
- `conversation-evaluation.txt`: Used to evaluate the quality of conversations.
- `conversation-information-extraction.txt`: Used to evaluate the extracted information from conversations.

## Architecture

The project is split into three main parts:
- `src/conversation-generator.ts`: Used to generate conversations.
- `src/conversation-evaluator.ts`: Used to evaluate the quality of conversations.
- `src/test-bench.ts`: Used to run the test suites.

## Roadmap

- Add support for [Ultravox](https://www.ultravox.ai/), an open-weight speech-to-speech model.
- Enable to run the tests using real human voice instead of generated text/TTS.
- Automate the turn management (currently hardcoded in the test definition).
- Explore a more agentic design.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

# About me

I'm a software developer turned product manager, turned software developer again thanks to generate AI. 
This projects has been developed with support of [Cursor](https://www.cursor.com/).

Please reach out if you have any questions or feedback!
LinkedIn: https://www.linkedin.com/in/arnaudbreton/