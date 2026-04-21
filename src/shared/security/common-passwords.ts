/**
 * Common Passwords List
 *
 * Source: https://github.com/danielmiessler/SecLists/blob/master/Passwords/Common-Credentials/10-million-password-list-top-10000.txt
 * Supplemented with Kenya-specific and regional patterns.
 *
 * For production: replace/supplement with the full SecLists 10,000-entry list.
 * Check is case-insensitive  -  normalize input with .toLowerCase() before lookup.
 */
export const COMMON_PASSWORDS = new Set<string>([
  // -- Universal top passwords ----------------------------------------------
  '123456', 'password', '123456789', '12345678', '12345', '1234567',
  '1234567890', '1234', 'qwerty', 'abc123', 'password1', 'iloveyou',
  '111111', '123123', 'admin', 'letmein', 'welcome', 'monkey', 'login',
  'passw0rd', 'master', 'hello', 'dragon', 'princess', 'baseball', 'football',
  'soccer', 'shadow', 'sunshine', 'pass', 'test', 'secret', 'root', 'toor',
  'default', 'guest', 'changeme', '0000', '000000', '1111', '111111',
  '1111111', '11111111', '11111', '123321', 'qazwsx', 'trustno1', 'superman',
  'batman', 'hello123', 'charlie', 'donald', 'p@ssw0rd', 'pass123', 'pass@123',
  'admin123', 'administrator', 'root123', 'toor123', 'system', 'manager',
  'user', 'user123', '654321', '112233', '121212', '696969', '666666',
  '131313', '123654', 'qweqwe', 'zxcvbn', 'michael', 'jessica', 'daniel',
  'george', 'jordan', 'thomas', 'christopher', 'charles', 'andrew', 'joseph',
  'richard', 'letme1n', 'passw0rd1', '1q2w3e4r', '1q2w3e', 'q1w2e3r4',
  'q1w2e3', 'abc1234', 'aaa111', 'a1b2c3', 'a12345', 'aa123456', 'asdfgh',

  // -- Year-based passwords --------------------------------------------------
  'password2024', 'password2023', 'password2022', 'password2021', 'password2020',
  'password2019', 'password2018', 'password2017', 'password2016',
  'admin2024', 'admin2023', 'admin2022', 'admin2021', 'admin2020', 'admin2019',
  'welcome2024', 'welcome2023', 'welcome2022', 'welcome2021',
  '2024', '2023', '2022', '2021', '2020', '2019', '2018', '2017',

  // -- Keyboard patterns ----------------------------------------------------
  'qwertyui', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'zxcvbnm123',
  'qweasdzxc', '1qaz2wsx', '1qazxsw2', 'zaq12wsx', 'qwerty1', 'qwerty12',
  'qwerty123', 'qwerty1234', 'qwerty12345', 'q2w3e4r5', 'plokmijn',
  'mnbvcxz', '1qaz', '2wsx', '3edc', '4rfv', '!qaz', '!qazxsw@',

  // -- Numeric patterns -----------------------------------------------------
  '0987654321', '9876543210', '987654', '1122334455', '1234512345',
  '1234554321', '12341234', '43214321', '11223344', '99999999', '55555555',
  '10203040', '11001100', '12121212', '11111111', '00000000',

  // -- Dictionary words + common substitutions ------------------------------
  'computer', 'internet', 'email', 'mobile', 'phone', 'samsung',
  'iphone', 'android', 'windows', 'linux', 'ubuntu', 'chrome',
  'google', 'facebook', 'twitter', 'instagram', 'linkedin', 'youtube',
  'apple', 'microsoft', 'amazon', 'netflix', 'spotify', 'tiktok',
  'access', 'access123', 'access1234', 'picture1', 'football1',
  'baseball1', 'soccer1', 'hockey1', 'batman123', 'superman123',
  'spiderman1', 'pokemon', 'pokemon123', 'naruto', 'naruto123',
  'dragon123', 'wizard123', 'monkey123', 'cookie', 'cookie123',
  'ninja', 'pirate', 'viking', 'warrior', 'hunter', 'killer',
  'ranger', 'sniper', 'soldier', 'champion', 'legend',

  // -- Calendar words -------------------------------------------------------
  'winter', 'summer', 'autumn', 'spring', 'october', 'november',
  'january', 'february', 'march', 'april', 'june', 'july', 'august',
  'september', 'december', 'monday', 'tuesday', 'wednesday', 'thursday',
  'friday', 'saturday', 'sunday',

  // -- Common leet-speak patterns -------------------------------------------
  'p@ssw0rd', 'p@ss123', 'p@ssword', 'pa$$word', 'p@55w0rd',
  'passw0rd1', 'pa$$w0rd', 'p@ssw0rd1', 'P@ssw0rd', 'P@ssword1',
  'P@55word', 'P4ssw0rd', 'Passw0rd!', 'pass@word', 'Pass@1234',
  'Pass@123', 'Pass1234!', 'Password!', 'Password1!', 'Welcome1!',
  'Welcome@1', 'Admin@123', 'Admin1234',

  // -- Repeated/pattern sequences -------------------------------------------
  'abcabc', 'abcabcabc', '123123123', '456456', '789789',
  '232323', '010101', 'xoxoxo', 'lololo', 'aaaa1111',

  // -- Names + numbers ------------------------------------------------------
  'michael1', 'jessica1', 'password01', 'password1234', 'jennifer',
  'joshua', 'david123', 'matthew', 'ashley', 'amanda', 'andrew1',
  'kevin123', 'kevin', 'steven', 'nicholas', 'robert', 'william',
  'james', 'john', 'james123', 'john123', 'mary123', 'peter123',

  // -- Business / IT defaults -----------------------------------------------
  'company', 'company123', 'company2024', 'company@123',
  'business', 'business123', 'business@123',
  'temp', 'temppass', 'testing', 'testing123', 'demo', 'demo123',
  'temp123', 'temp1234', 'service', 'support', 'helpdesk',
  'network', 'server', 'database', 'backup', 'deploy', 'devops',
  'staging', 'production', 'develop', 'developer',

  // -- Kenya-specific -------------------------------------------------------
  'kenya', 'kenya1', 'kenya12', 'kenya123', 'kenya1234', 'kenya2024',
  'kenya2023', 'kenya2022', 'kenya@123', 'kenya#123', 'kenya@2024',
  'kenya@2023',
  'nairobi', 'nairobi1', 'nairobi123', 'nairobi2024', 'nairobi@123',
  'nairobi@2024',
  'safaricom', 'safaricom1', 'safaricom123', 'safcom', 'safcom123',
  'mpesa', 'mpesa1', 'mpesa123', 'mpesa1234', 'mpesa@123', 'mpesa2024',
  'mombasa', 'mombasa1', 'mombasa123', 'mombasa2024',
  'kisumu', 'kisumu1', 'kisumu123',
  'eldoret', 'eldoret1', 'eldoret123',
  'nakuru', 'nakuru1', 'nakuru123',
  'thika', 'thika1', 'thika123',
  'nyeri', 'nyeri1', 'nyeri123',
  'africa', 'africa1', 'africa123', 'africa1234', 'africa2024',
  'eastafrica', 'eastafrica123',
  'kenyatta', 'uhuru', 'uhuru123', 'raila', 'raila123',
  'jamhuri', 'jamhuri123', 'harambee', 'harambee1', 'harambee123',
  'simba', 'simba1', 'simba123', 'twiga', 'twiga1', 'twiga123',
  'hakuna', 'hakuna1', 'hakuna123', 'rafiki', 'rafiki1', 'rafiki123',
  'sheria', 'sheria1', 'sheria123', 'sheria1234',
  'equity', 'equity1', 'equity123', 'kcb', 'kcb1', 'kcb123',
  'cooperative', 'coopbank', 'stanchart', 'barclays', 'absa',
  'cbk', 'cbk123', 'cbk2024',
  'fintech', 'fintech1', 'fintech123', 'fintech2024',
  'watu', 'watu123', 'pesa', 'pesa123',
  'boda', 'boda123', 'matatu', 'matatu123',
  'kilimanjaro', 'serengeti', 'maasai', 'maasai1', 'maasai123',

  // -- Sports ---------------------------------------------------------------
  'barcelona', 'manchester', 'liverpool', 'arsenal', 'chelsea',
  'juventus', 'realmadrid', 'milan', 'atletico', 'dortmund',
  'gorjao', 'gor', 'afc', 'afc123', 'tusker', 'tusker123',
  'harambee', 'stars123',
]);

/**
 * Returns true if the password appears in the common passwords list.
 * Case-insensitive.
 */
export function isCommonPassword(password: string): boolean {
  return COMMON_PASSWORDS.has(password.toLowerCase());
}
