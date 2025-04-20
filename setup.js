/**
 * BattleTask Extension Setup Script
 * 
 * This script helps set up the configuration files for the BattleTask extension.
 * It creates a config.js file from config.template.js and prompts for the API key.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Check if .env file exists
const envPath = path.join(__dirname, '.env');
const envExists = fs.existsSync(envPath);

// Check if config.js exists
const configPath = path.join(__dirname, 'config.js');
const configExists = fs.existsSync(configPath);

// Check if config.template.js exists
const templatePath = path.join(__dirname, 'config.template.js');
const templateExists = fs.existsSync(templatePath);

console.log('\n🚀 BattleTask Extension Setup\n');

// Function to prompt for API key
function promptForApiKey() {
  return new Promise((resolve) => {
    rl.question('Enter your Google Gemini API key: ', (apiKey) => {
      if (!apiKey || apiKey.trim() === '') {
        console.log('❌ API key cannot be empty. Please try again.');
        promptForApiKey().then(resolve);
      } else {
        resolve(apiKey.trim());
      }
    });
  });
}

// Main setup function
async function setup() {
  try {
    // Handle .env file
    if (!envExists) {
      console.log('📝 Creating .env file...');
      const apiKey = await promptForApiKey();
      fs.writeFileSync(envPath, `GEMINI_API_KEY=${apiKey}\n`);
      console.log('✅ .env file created successfully!');
    } else {
      console.log('ℹ️ .env file already exists. Skipping creation.');
    }

    // Handle config.js file
    if (!configExists) {
      if (templateExists) {
        console.log('📝 Creating config.js from template...');
        
        // Read the template
        let templateContent = fs.readFileSync(templatePath, 'utf8');
        
        // Get API key from .env or prompt for it
        let apiKey;
        if (envExists) {
          const envContent = fs.readFileSync(envPath, 'utf8');
          const match = envContent.match(/GEMINI_API_KEY=(.+)/);
          if (match && match[1]) {
            apiKey = match[1].trim();
          }
        }
        
        if (!apiKey) {
          apiKey = await promptForApiKey();
        }
        
        // Replace placeholder with actual API key
        templateContent = templateContent.replace('YOUR_GEMINI_API_KEY_HERE', apiKey);
        
        // Write to config.js
        fs.writeFileSync(configPath, templateContent);
        console.log('✅ config.js created successfully!');
      } else {
        console.log('❌ config.template.js not found. Cannot create config.js.');
      }
    } else {
      console.log('ℹ️ config.js already exists. Skipping creation.');
    }

    console.log('\n🎉 Setup complete! You can now run the extension.\n');
  } catch (error) {
    console.error('❌ Error during setup:', error.message);
  } finally {
    rl.close();
  }
}

// Run the setup
setup();
