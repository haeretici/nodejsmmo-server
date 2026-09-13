CREATE TABLE IF NOT EXISTS accounts (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    status ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    failed_logins INT UNSIGNED NOT NULL DEFAULT 0,
    locked_until DATETIME(3) NULL,
    last_login_at DATETIME(3) NULL,
    last_login_ip VARCHAR(45) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_accounts_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account_sessions (
    token_hash BINARY(32) NOT NULL,
    account_id INT UNSIGNED NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    user_agent VARCHAR(255) NULL,
    ip VARCHAR(45) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (token_hash),
    KEY idx_sessions_account (account_id),
    KEY idx_sessions_expires (expires_at),
    CONSTRAINT fk_sessions_account
        FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS characters (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    account_id INT UNSIGNED NOT NULL,
    name VARCHAR(32) NOT NULL,
    vocation VARCHAR(32) NOT NULL,
    level INT UNSIGNED NOT NULL DEFAULT 1,
    experience BIGINT UNSIGNED NOT NULL DEFAULT 0,
    pos_x INT NOT NULL DEFAULT 0,
    pos_y INT NOT NULL DEFAULT 0,
    pos_z INT NOT NULL DEFAULT 0,
    hp INT UNSIGNED NOT NULL DEFAULT 185,
    hp_max INT UNSIGNED NOT NULL DEFAULT 185,
    mp INT UNSIGNED NOT NULL DEFAULT 90,
    mp_max INT UNSIGNED NOT NULL DEFAULT 90,
    town_id INT UNSIGNED NOT NULL DEFAULT 1,
    last_login DATETIME(3) NULL,
    last_logout DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_characters_name (name),
    KEY idx_characters_account (account_id),
    CONSTRAINT fk_characters_account
        FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS character_skills (
    character_id INT UNSIGNED NOT NULL,
    fist SMALLINT UNSIGNED NOT NULL DEFAULT 10,
    club SMALLINT UNSIGNED NOT NULL DEFAULT 10,
    sword SMALLINT UNSIGNED NOT NULL DEFAULT 10,
    axe SMALLINT UNSIGNED NOT NULL DEFAULT 10,
    distance SMALLINT UNSIGNED NOT NULL DEFAULT 10,
    shielding SMALLINT UNSIGNED NOT NULL DEFAULT 10,
    magic SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    fishing SMALLINT UNSIGNED NOT NULL DEFAULT 10,
    fist_tries BIGINT UNSIGNED NOT NULL DEFAULT 0,
    club_tries BIGINT UNSIGNED NOT NULL DEFAULT 0,
    sword_tries BIGINT UNSIGNED NOT NULL DEFAULT 0,
    axe_tries BIGINT UNSIGNED NOT NULL DEFAULT 0,
    distance_tries BIGINT UNSIGNED NOT NULL DEFAULT 0,
    shielding_tries BIGINT UNSIGNED NOT NULL DEFAULT 0,
    magic_tries BIGINT UNSIGNED NOT NULL DEFAULT 0,
    fishing_tries BIGINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (character_id),
    CONSTRAINT fk_skills_character
        FOREIGN KEY (character_id) REFERENCES characters (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS character_state (
    character_id INT UNSIGNED NOT NULL,
    inventory JSON NOT NULL,
    storage JSON NOT NULL,
    conditions JSON NOT NULL,
    hotkeys JSON NOT NULL,
    appearance JSON NOT NULL,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (character_id),
    CONSTRAINT fk_state_character
        FOREIGN KEY (character_id) REFERENCES characters (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS play_tokens (
    token_hash BINARY(32) NOT NULL,
    account_id INT UNSIGNED NOT NULL,
    character_id INT UNSIGNED NOT NULL,
    ip VARCHAR(45) NULL,
    expires_at DATETIME(3) NOT NULL,
    used_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (token_hash),
    KEY idx_play_tokens_character (character_id),
    KEY idx_play_tokens_expires (expires_at),
    CONSTRAINT fk_play_tokens_account
        FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
    CONSTRAINT fk_play_tokens_character
        FOREIGN KEY (character_id) REFERENCES characters (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ip_bans (
    ip VARCHAR(45) NOT NULL,
    reason VARCHAR(255) NOT NULL,
    expires_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (ip)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account_bans (
    account_id INT UNSIGNED NOT NULL,
    reason VARCHAR(255) NOT NULL,
    expires_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (account_id),
    CONSTRAINT fk_account_bans_account
        FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
